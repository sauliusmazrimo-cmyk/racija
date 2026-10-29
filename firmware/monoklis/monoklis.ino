/*
  311 VoiceCH monoklis – Seeed XIAO ESP32C3 + OLED 0,96" SSD1306 (I2C) + BNO085

  Telefonas (311 VoiceCH programėlė) per Bluetooth LE siunčia:
    N|azimutas|atstumas_m|pavadinimas   – susitikimo vieta (azimutas nuo šiaurės, -1 = nėra)
    M|tekstas|siuntėjas                 – komanda / LoRa žinutė (rodoma 10 s)
    A|tekstas|siuntėjas                 – STOP (mirksi, kol patvirtinama arba 30 s)
    X                                   – STOP patvirtintas
    T|vardas                            – kas dabar kalba ("" = niekas)
    K|1  K|2  K|0                       – kalibravimas: 1 žiūrėk tiesiai, 2 nulenk galvą, 0 atstatyti
    L|0..255  F|0/1  D|laipsniai  O|laipsniai – ryškumas, apversti 180°, magnetinė deklinacija, pataisa
    P                                   – būsenos užklausa
  Monoklis kas 2 s praneša: S|kryptis|tikslumas0-3|baterija_mV|kalibruota|versija

  Laidai: OLED ir BNO085: 3V3, GND, SDA=D4, SCL=D5.  BNO085: INT=D2, RST=D3.
  Baterijos įtampa (nebūtina): BAT+ (po jungikliu) –100k– A0 –100k– GND.
*/
#include <Wire.h>
#include <U8g2lib.h>
#include <SparkFun_BNO08x_Arduino_Library.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLE2902.h>
#include <Preferences.h>
#include <math.h>

#define FW_VER "1.0"
#define SVC_UUID "7a1e0001-3110-4c48-9f0b-6d6f6e6f6b6c"
#define RX_UUID  "7a1e0002-3110-4c48-9f0b-6d6f6e6f6b6c"
#define TX_UUID  "7a1e0003-3110-4c48-9f0b-6d6f6e6f6b6c"

const int PIN_INT = D2, PIN_RST = D3, PIN_BAT = A0;

U8G2_SSD1306_128X64_NONAME_F_HW_I2C oled(U8G2_R0, U8X8_PIN_NONE);
BNO08x imu;
Preferences prefs;

// ---------------- būsena ----------------
struct Nav { bool has = false; float brg = 0, dist = 0; char title[40] = ""; uint32_t at = 0; } nav;
char talker[24] = "";
char msgText[160] = "", msgFrom[32] = ""; uint32_t msgUntil = 0;
bool alarmOn = false; char alarmText[80] = "", alarmFrom[32] = ""; uint32_t alarmAt = 0;
bool connected = false; uint32_t connectedAt = 0;

bool imuOk = false; uint32_t imuRetry = 0;
float q[4] = {1, 0, 0, 0};          // w, x, y, z
uint8_t qAcc = 0;
float heading = 0; bool headingOk = false;
float fwd[3] = {1, 0, 0};           // „pirmyn“ ašis jutiklio koordinatėse
float cal1[3]; bool cal1Ok = false;
bool calibrated = false;
float decl = 7.5f, hOffset = 0;     // Lietuvoje deklinacija ~ +7–8°
uint8_t contrast = 160; bool flip = false;
int battMv = 0;

// ---------------- gaunamos žinutės (BLE gija -> loop) ----------------
#define INQ 8
static char inbox[INQ][200];
static volatile uint8_t inHead = 0, inTail = 0;
static portMUX_TYPE inMux = portMUX_INITIALIZER_UNLOCKED;

BLECharacteristic *txC = nullptr;
BLEServer *srv = nullptr;

class SrvCB : public BLEServerCallbacks {
  void onConnect(BLEServer *s) override { connected = true; connectedAt = millis(); }
  void onDisconnect(BLEServer *s) override { connected = false; delay(50); BLEDevice::startAdvertising(); }
};
class RxCB : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic *c) override {
    String v = String(c->getValue().c_str());
    // vienoje rašymo operacijoje gali būti kelios eilutės
    int start = 0;
    while (start < (int)v.length()) {
      int nl = v.indexOf('\n', start); if (nl < 0) nl = v.length();
      if (nl > start) {
        portENTER_CRITICAL(&inMux);
        uint8_t nh = (inHead + 1) % INQ;
        if (nh != inTail) {
          int n = min(nl - start, 199);
          memcpy(inbox[inHead], v.c_str() + start, n); inbox[inHead][n] = 0; inHead = nh;
        }
        portEXIT_CRITICAL(&inMux);
      }
      start = nl + 1;
    }
  }
};

// ---------------- vektorių matematika ----------------
static void qrot(const float *qq, const float *v, float *o) {   // o = q v q*
  float w = qq[0], x = qq[1], y = qq[2], z = qq[3];
  float tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0]);
  o[0] = v[0] + w * tx + (y * tz - z * ty);
  o[1] = v[1] + w * ty + (z * tx - x * tz);
  o[2] = v[2] + w * tz + (x * ty - y * tx);
}
static void upInSensor(float *u) {          // pasaulio „aukštyn“ jutiklio koordinatėse
  float qc[4] = {q[0], -q[1], -q[2], -q[3]}, z[3] = {0, 0, 1};
  qrot(qc, z, u);
}
static float wrap180(float a) { while (a > 180) a -= 360; while (a < -180) a += 360; return a; }
static float wrap360(float a) { while (a >= 360) a -= 360; while (a < 0) a += 360; return a; }

void loadPrefs() {
  prefs.begin("mono", true);
  calibrated = prefs.getBool("cal", false);
  fwd[0] = prefs.getFloat("f0", 1); fwd[1] = prefs.getFloat("f1", 0); fwd[2] = prefs.getFloat("f2", 0);
  decl = prefs.getFloat("decl", 7.5f); hOffset = prefs.getFloat("off", 0);
  contrast = prefs.getUChar("lum", 160); flip = prefs.getBool("flip", false);
  prefs.end();
}
void savePrefs() {
  prefs.begin("mono", false);
  prefs.putBool("cal", calibrated);
  prefs.putFloat("f0", fwd[0]); prefs.putFloat("f1", fwd[1]); prefs.putFloat("f2", fwd[2]);
  prefs.putFloat("decl", decl); prefs.putFloat("off", hOffset);
  prefs.putUChar("lum", contrast); prefs.putBool("flip", flip);
  prefs.end();
}

void applyDisplay() {
  oled.setContrast(contrast);
  oled.setDisplayRotation(flip ? U8G2_R2 : U8G2_R0);
}

// ---------------- komandos ----------------
static int split(char *s, char **parts, int maxp) {
  int n = 0; parts[n++] = s;
  for (char *p = s; *p && n < maxp; p++) if (*p == '|') { *p = 0; parts[n++] = p + 1; }
  return n;
}
static void copyStr(char *dst, const char *src, size_t cap) { strncpy(dst, src, cap - 1); dst[cap - 1] = 0; }

void notifyStatus();

void handle(char *line) {
  char *p[5]; int n = split(line, p, 5);
  char c = p[0][0];
  uint32_t now = millis();
  switch (c) {
    case 'N':
      if (n >= 3 && atof(p[1]) >= 0) {
        nav.has = true; nav.brg = atof(p[1]); nav.dist = atof(p[2]);
        copyStr(nav.title, n >= 4 ? p[3] : "", sizeof nav.title);
      } else nav.has = false;
      nav.at = now; break;
    case 'M':
      copyStr(msgText, n >= 2 ? p[1] : "", sizeof msgText);
      copyStr(msgFrom, n >= 3 ? p[2] : "", sizeof msgFrom);
      msgUntil = now + 10000; break;
    case 'A':
      copyStr(alarmText, n >= 2 ? p[1] : "STOP", sizeof alarmText);
      copyStr(alarmFrom, n >= 3 ? p[2] : "", sizeof alarmFrom);
      alarmOn = true; alarmAt = now; break;
    case 'X': alarmOn = false; break;
    case 'T': copyStr(talker, n >= 2 ? p[1] : "", sizeof talker); break;
    case 'K':
      if (n >= 2 && p[1][0] == '1') { upInSensor(cal1); cal1Ok = true; }
      else if (n >= 2 && p[1][0] == '2' && cal1Ok) {
        float u2[3]; upInSensor(u2);
        float d = u2[0] * cal1[0] + u2[1] * cal1[1] + u2[2] * cal1[2];
        float f[3] = {-(u2[0] - d * cal1[0]), -(u2[1] - d * cal1[1]), -(u2[2] - d * cal1[2])};
        float len = sqrtf(f[0] * f[0] + f[1] * f[1] + f[2] * f[2]);
        if (len > 0.25f) {                  // galva nulenkta bent ~15°
          for (int i = 0; i < 3; i++) fwd[i] = f[i] / len;
          calibrated = true; hOffset = 0; savePrefs();
          copyStr(msgText, "Kalibruota", sizeof msgText); copyStr(msgFrom, "", sizeof msgFrom);
        } else {
          copyStr(msgText, "Per mažai nulenkei galvą. Kartok.", sizeof msgText); copyStr(msgFrom, "", sizeof msgFrom);
        }
        msgUntil = now + 3000; cal1Ok = false;
      } else if (n >= 2 && p[1][0] == '0') {
        calibrated = false; fwd[0] = 1; fwd[1] = 0; fwd[2] = 0; hOffset = 0; savePrefs();
      }
      break;
    case 'L': if (n >= 2) { contrast = constrain(atoi(p[1]), 0, 255); applyDisplay(); savePrefs(); } break;
    case 'F': if (n >= 2) { flip = p[1][0] == '1'; applyDisplay(); savePrefs(); } break;
    case 'D': if (n >= 2) { decl = atof(p[1]); savePrefs(); } break;
    case 'O': if (n >= 2) { hOffset = wrap180(atof(p[1])); savePrefs(); } break;
    case 'P': notifyStatus(); break;
  }
}

// ---------------- jutikliai ----------------
void imuBegin() {
  imuOk = false;
  for (uint8_t addr : {0x4A, 0x4B}) {
    if (imu.begin(addr, Wire, PIN_INT, PIN_RST)) { imuOk = true; break; }
  }
  if (imuOk) imu.enableRotationVector(40);
  imuRetry = millis() + 5000;
}

void imuPoll() {
  if (!imuOk) { if (millis() > imuRetry) imuBegin(); return; }
  if (imu.wasReset()) imu.enableRotationVector(40);
  for (int i = 0; i < 5 && imu.getSensorEvent(); i++) {
    if (imu.getSensorEventID() != SENSOR_REPORTID_ROTATION_VECTOR) continue;
    q[0] = imu.getQuatReal(); q[1] = imu.getQuatI(); q[2] = imu.getQuatJ(); q[3] = imu.getQuatK();
    qAcc = imu.getQuatAccuracy();
    float fw[3]; qrot(q, fwd, fw);                       // „pirmyn“ pasaulio koordinatėse (X rytai, Y šiaurė, Z aukštyn)
    if (fabsf(fw[2]) > 0.9f) continue;                   // žiūri tiesiai aukštyn/žemyn – krypties nekeičiam
    float h = wrap360(atan2f(fw[0], fw[1]) * 180.0f / PI + decl + hOffset);
    if (!headingOk) { heading = h; headingOk = true; }
    else heading = wrap360(heading + 0.35f * wrap180(h - heading));   // švelninimas
  }
}

void battPoll() {
  static uint32_t t = 0;
  if (millis() - t < 3000) return; t = millis();
  uint32_t s = 0; for (int i = 0; i < 8; i++) s += analogReadMilliVolts(PIN_BAT);
  int mv = s / 8 * 2;
  battMv = (mv > 3000 && mv < 4400) ? mv : 0;           // 0 = daliklis neprijungtas
}
int battPct() { return battMv ? constrain(map(battMv, 3350, 4150, 0, 100), 0, 100) : -1; }

void notifyStatus() {
  if (!connected || !txC) return;
  char b[64];
  snprintf(b, sizeof b, "S|%d|%d|%d|%d|%s", headingOk ? (int)heading : -1, qAcc, battMv, calibrated ? 1 : 0, FW_VER);
  txC->setValue((uint8_t *)b, strlen(b));
  txC->notify();
}

// ---------------- piešimas ----------------
void drawArrow(int cx, int cy, int r, float deg) {
  float a = deg * PI / 180.0f, s = sinf(a), c = cosf(a);
  auto P = [&](float x, float y, int &ox, int &oy) { ox = cx + (int)lroundf(x * c - y * s); oy = cy + (int)lroundf(x * s + y * c); };
  int tx, ty, lx, ly, rx, ry, nx, ny;
  P(0, -r, tx, ty); P(-r * 0.62f, r * 0.62f, lx, ly); P(r * 0.62f, r * 0.62f, rx, ry); P(0, r * 0.2f, nx, ny);
  oled.drawTriangle(tx, ty, lx, ly, nx, ny);
  oled.drawTriangle(tx, ty, nx, ny, rx, ry);
}

void fmtDist(float m, char *num, char *unit) {
  if (m < 1000) { sprintf(num, "%d", (int)lroundf(m)); strcpy(unit, "m"); }
  else if (m < 10000) { sprintf(num, "%d,%d", (int)(m / 1000), (int)(fmodf(m, 1000) / 100)); strcpy(unit, "km"); }
  else { sprintf(num, "%d", (int)lroundf(m / 1000)); strcpy(unit, "km"); }
}

// teksto laužymas į eilutes pagal plotį (UTF-8)
int wrapDraw(const char *txt, int x, int y, int w, int lineH, int maxLines) {
  char line[64] = ""; const char *p = txt; int lines = 0;
  while (*p && lines < maxLines) {
    const char *wEnd = p; while (*wEnd && *wEnd != ' ') wEnd++;
    char cand[64]; snprintf(cand, sizeof cand, "%s%s%.*s", line, line[0] ? " " : "", (int)(wEnd - p), p);
    if (oled.getUTF8Width(cand) <= w || !line[0]) { copyStr(line, cand, sizeof line); p = *wEnd ? wEnd + 1 : wEnd; }
    else { oled.drawUTF8(x, y + lines * lineH, line); lines++; line[0] = 0; }
  }
  if (line[0] && lines < maxLines) { oled.drawUTF8(x, y + lines * lineH, line); lines++; }
  return lines;
}

void drawStatusRow() {
  oled.setFont(u8g2_font_5x8_tf);
  if (talker[0]) {
    char b[40]; snprintf(b, sizeof b, "> %s", talker);
    oled.setFont(u8g2_font_6x12_te); oled.drawUTF8(66, 9, b);
    return;
  }
  int pc = battPct();
  if (pc >= 0) {
    bool low = pc < 15;
    if (!low || (millis() / 500) % 2) {
      oled.drawFrame(110, 1, 15, 7); oled.drawBox(125, 3, 2, 3);
      oled.drawBox(112, 3, (11 * pc) / 100, 3);
    }
  }
  if (!connected) { oled.setFont(u8g2_font_5x8_tf); oled.drawStr(66, 8, "BT --"); }
  else if (!calibrated && (millis() / 700) % 2) { oled.setFont(u8g2_font_5x8_tf); oled.drawStr(66, 8, "KALIBR."); }
}

void drawNav() {
  uint32_t now = millis();
  bool fresh = connected && nav.has && now - nav.at < 30000;
  if (fresh && nav.dist < 25) {
    oled.drawCircle(32, 32, 24); oled.drawCircle(32, 32, 14); oled.drawDisc(32, 32, 4);
    oled.setFont(u8g2_font_10x20_te); oled.drawUTF8(80, 40, "ČIA");
  } else if (fresh) {
    if (headingOk) drawArrow(32, 32, 28, wrap180(nav.brg - heading));
    else { oled.setFont(u8g2_font_6x12_te); oled.drawUTF8(4, 36, "kompasas?"); }
    char num[12], unit[4]; fmtDist(nav.dist, num, unit);
    oled.setFont(u8g2_font_logisoso22_tr);
    int w = oled.getStrWidth(num);
    if (w > 60) { oled.setFont(u8g2_font_logisoso16_tr); w = oled.getStrWidth(num); }
    oled.drawStr(126 - w, 40, num);
    oled.setFont(u8g2_font_6x12_te); oled.drawUTF8(126 - oled.getUTF8Width(unit), 52, unit);
    if (now - nav.at > 8000) oled.drawStr(66, 52, "?");
  } else {
    // nėra tikslo – rodom kompasą
    oled.drawCircle(32, 32, 27);
    if (headingOk) {
      drawArrow(32, 32, 22, wrap180(-heading));   // rodyklė į šiaurę
      char b[8]; sprintf(b, "%d°", (int)lroundf(heading) % 360);
      oled.setFont(u8g2_font_logisoso16_tf); oled.drawUTF8(126 - oled.getUTF8Width(b), 38, b);
    } else if (!imuOk) { oled.setFont(u8g2_font_6x12_te); oled.drawUTF8(70, 36, "nėra kompaso"); }
    oled.setFont(u8g2_font_6x12_te);
    oled.drawUTF8(66, 52, !connected ? "Laukiu tel." : nav.has ? "Senas tikslas" : "Nėra tikslo");
  }
  if (fresh && nav.title[0]) {
    char t[14]; copyStr(t, nav.title, sizeof t);
    oled.setFont(u8g2_font_6x12_te); oled.drawUTF8(66, 63, t);
  }
  drawStatusRow();
}

void drawMsg() {
  oled.setDrawColor(1); oled.drawBox(0, 0, 128, 13);
  oled.setDrawColor(0); oled.setFont(u8g2_font_6x12_te);
  oled.drawUTF8(2, 10, msgFrom[0] ? msgFrom : "311 VoiceCH");
  oled.setDrawColor(1);
  oled.setFont(u8g2_font_9x15_te);
  if (wrapDraw(msgText, 1, 29, 126, 16, 3) >= 3 && strlen(msgText) > 40) {
    // per ilgas – mažesnis šriftas
    oled.setDrawColor(0); oled.drawBox(0, 14, 128, 50); oled.setDrawColor(1);
    oled.setFont(u8g2_font_6x12_te); wrapDraw(msgText, 1, 25, 126, 12, 4);
  }
}

void drawAlarm() {
  bool inv = (millis() / 350) % 2;
  if (inv) { oled.setDrawColor(1); oled.drawBox(0, 0, 128, 64); oled.setDrawColor(0); }
  bool isStop = strstr(alarmText, "STOP") || strstr(alarmText, "stop") || strstr(alarmText, "Stop");
  if (isStop) {
    oled.setFont(u8g2_font_logisoso32_tr);
    oled.drawStr((128 - oled.getStrWidth("STOP")) / 2, 40, "STOP");
  } else {
    oled.setFont(u8g2_font_9x15_te); wrapDraw(alarmText, 2, 16, 124, 16, 3);
  }
  oled.setFont(u8g2_font_6x12_te);
  oled.drawUTF8((128 - oled.getUTF8Width(alarmFrom)) / 2, 60, alarmFrom);
  oled.setDrawColor(1);
}

// ---------------- pagrindinis ----------------
void setup() {
  Serial.begin(115200);
  pinMode(PIN_BAT, INPUT);
  analogReadResolution(12);
  loadPrefs();

  Wire.begin();
  Wire.setClock(400000);
  oled.setBusClock(400000);
  oled.begin();
  oled.enableUTF8Print();
  applyDisplay();
  oled.clearBuffer();
  oled.setFont(u8g2_font_9x15_te); oled.drawUTF8(10, 28, "311 VoiceCH");
  oled.setFont(u8g2_font_6x12_te); oled.drawUTF8(10, 46, "monoklis v" FW_VER);
  oled.sendBuffer();

  imuBegin();

  uint64_t mac = ESP.getEfuseMac();
  char name[24]; snprintf(name, sizeof name, "311-Monoklis-%02X%02X", (uint8_t)(mac >> 32), (uint8_t)(mac >> 40));
  BLEDevice::init(name);
  srv = BLEDevice::createServer(); srv->setCallbacks(new SrvCB());
  BLEService *svc = srv->createService(SVC_UUID);
  BLECharacteristic *rx = svc->createCharacteristic(RX_UUID, BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_WRITE_NR);
  rx->setCallbacks(new RxCB());
  txC = svc->createCharacteristic(TX_UUID, BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY);
  txC->addDescriptor(new BLE2902());
  svc->start();
  BLEAdvertising *adv = BLEDevice::getAdvertising();
  adv->addServiceUUID(SVC_UUID);
  adv->setScanResponse(true);
  BLEDevice::startAdvertising();
  delay(600);
}

void loop() {
  // žinutės iš telefono
  while (inTail != inHead) {
    char line[200];
    portENTER_CRITICAL(&inMux);
    memcpy(line, inbox[inTail], sizeof line); inTail = (inTail + 1) % INQ;
    portEXIT_CRITICAL(&inMux);
    handle(line);
  }
  imuPoll();
  battPoll();

  static uint32_t lastNotify = 0;
  if (millis() - lastNotify > 2000) { lastNotify = millis(); notifyStatus(); }
  if (alarmOn && millis() - alarmAt > 30000) alarmOn = false;

  static uint32_t lastDraw = 0;
  if (millis() - lastDraw < 50) return;   // ~20 kadrų/s
  lastDraw = millis();
  oled.clearBuffer();
  if (alarmOn) drawAlarm();
  else if (millis() < msgUntil) drawMsg();
  else drawNav();
  oled.sendBuffer();
}
