/*
  311 VoiceCH monoklis – Seeed XIAO ESP32C3 + OLED 0,96" SSD1306 (I2C) + BNO085

  Telefonas (311 VoiceCH programėlė) per Bluetooth LE siunčia:
    N|azimutas|atstumas_m|pavadinimas   – susitikimo vieta (azimutas nuo šiaurės, -1 = nėra)
    M|tekstas|siuntėjas                 – komanda / LoRa žinutė (rodoma 10 s)
    A|tekstas|siuntėjas                 – STOP (mirksi, kol patvirtinama arba 30 s)
    X                                   – STOP patvirtintas
    T|vardas                            – kas dabar kalba ("" = niekas)
    R|azimutas,atstumas,inicialai;...   – kanalo nariai radarui (iki 8)
    V|0/1                               – vaizdas: 0 automatinis, 1 visada radaras
    K|1  K|2  K|0                       – kalibravimas: 1 žiūrėk tiesiai, 2 nulenk galvą, 0 atstatyti
    L|0..255  F|0/1  D|laipsniai  O|laipsniai – ryškumas, apversti 180°, magnetinė deklinacija, pataisa
    P                                   – būsenos užklausa
  Monoklis kas 2 s praneša: S|kryptis|tikslumas0-3|baterija_mV|kalibruota|versija
  Kalbėjimo (PTT) mygtukas tarp D1 ir GND: B|1 paspaustas, B|0 atleistas

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

#define FW_VER "2.0"
#define SVC_UUID "7a1e0001-3110-4c48-9f0b-6d6f6e6f6b6c"
#define RX_UUID  "7a1e0002-3110-4c48-9f0b-6d6f6e6f6b6c"
#define TX_UUID  "7a1e0003-3110-4c48-9f0b-6d6f6e6f6b6c"

const int PIN_INT = D2, PIN_RST = D3, PIN_BAT = A0, PIN_BTN = D1;
bool btnDown = false;

U8G2_SSD1306_128X64_NONAME_F_HW_I2C oled(U8G2_R0, U8X8_PIN_NONE);
BNO08x imu;
Preferences prefs;

// ---------------- būsena ----------------
struct Nav { bool has = false; float brg = 0, dist = 0; char title[40] = ""; uint32_t at = 0; } nav;
char talker[24] = "";
struct Mem { float brg, dist; char ini[8]; };
Mem mem[8]; int memN = 0; uint32_t memAt = 0;
uint8_t viewMode = 0;
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
  viewMode = prefs.getUChar("view", 0);
  prefs.end();
}
void savePrefs() {
  prefs.begin("mono", false);
  prefs.putBool("cal", calibrated);
  prefs.putFloat("f0", fwd[0]); prefs.putFloat("f1", fwd[1]); prefs.putFloat("f2", fwd[2]);
  prefs.putFloat("decl", decl); prefs.putFloat("off", hOffset);
  prefs.putUChar("lum", contrast); prefs.putBool("flip", flip);
  prefs.putUChar("view", viewMode);
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
    case 'R': {
      memN = 0; memAt = now;
      if (n < 2) break;
      char *save1 = nullptr;
      for (char *it = strtok_r(p[1], ";", &save1); it && memN < 8; it = strtok_r(nullptr, ";", &save1)) {
        char *save2 = nullptr;
        char *a = strtok_r(it, ",", &save2), *b = strtok_r(nullptr, ",", &save2), *c3 = strtok_r(nullptr, ",", &save2);
        if (!a || !b) continue;
        mem[memN].brg = atof(a); mem[memN].dist = atof(b);
        copyStr(mem[memN].ini, c3 ? c3 : "", sizeof mem[memN].ini);
        memN++;
      }
      break;
    }
    case 'V': if (n >= 2) { viewMode = atoi(p[1]) ? 1 : 0; savePrefs(); } break;
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

// ======== KARINIS HUD (128×64) ========
static void dotH(int x0, int x1, int y) { for (int x = x0; x <= x1; x += 2) oled.drawPixel(x, y); }
static void dotV(int x, int y0, int y1) { for (int y = y0; y <= y1; y += 2) oled.drawPixel(x, y); }
static bool blink(int ms) { return (millis() / ms) % 2; }
static void brackets(int x0, int y0, int x1, int y1, int L) {   // taikymo rėmelio kampai
  oled.drawHLine(x0, y0, L); oled.drawVLine(x0, y0, L); oled.drawHLine(x1 - L + 1, y0, L); oled.drawVLine(x1, y0, L);
  oled.drawHLine(x0, y1, L); oled.drawVLine(x0, y1 - L + 1, L); oled.drawHLine(x1 - L + 1, y1, L); oled.drawVLine(x1, y1 - L + 1, L);
}
static void diamond(int x, int y, int r, bool fill) {
  if (fill) { oled.drawTriangle(x - r, y, x, y - r, x + r, y); oled.drawTriangle(x - r, y, x, y + r, x + r, y); }
  else { oled.drawLine(x - r, y, x, y - r); oled.drawLine(x, y - r, x + r, y); oled.drawLine(x + r, y, x, y + r); oled.drawLine(x, y + r, x - r, y); }
}
static void fmtRng(float m, char *num, const char **unit) {
  if (m < 1000) { sprintf(num, "%d", (int)lroundf(m)); *unit = "M"; }
  else if (m < 10000) { sprintf(num, "%d.%d", (int)(m / 1000), (int)(fmodf(m, 1000) / 100)); *unit = "KM"; }
  else { sprintf(num, "%d", (int)lroundf(m / 1000)); *unit = "KM"; }
}

// kompaso juosta viršuje: ±45°, žymės kas 5°, užrašai kas 45°, tikslas – rombas
void drawTape(bool tgt, float tgtBrg) {
  static const char *LBL[] = {"N", "NE", "E", "SE", "S", "SW", "W", "NW"};
  const float PX = 128.0f / 90.0f;
  float h = headingOk ? heading : 0;
  oled.setFont(u8g2_font_4x6_tf);
  int first = ((int)floorf((h - 46) / 5)) * 5;
  for (int d = first; d <= h + 46; d += 5) {
    int x = 64 + (int)lroundf((d - h) * PX); if (x < 0 || x > 127) continue;
    int dd = ((d % 360) + 360) % 360;
    if (dd % 45 == 0) { oled.drawVLine(x, 8, 5); const char *t = LBL[dd / 45]; oled.drawStr(x - oled.getStrWidth(t) / 2 + 1, 6, t); }
    else if (dd % 15 == 0) { oled.drawVLine(x, 10, 3); }
    else oled.drawPixel(x, 12);
  }
  oled.drawHLine(0, 13, 128);
  oled.drawTriangle(61, 18, 67, 18, 64, 14);                 // tavo kryptis
  if (tgt && headingOk) {
    float rel = wrap180(tgtBrg - h);
    if (fabsf(rel) <= 44) diamond(64 + (int)lroundf(rel * PX), 10, 3, true);
    else if (blink(300)) { oled.setFont(u8g2_font_5x7_tf); oled.drawStr(rel < 0 ? 0 : 118, 7, rel < 0 ? "<<" : ">>"); }
  }
}

// apatinė eilutė: kas kalba / tikslas / ryšys, baterija
void drawBottom(const char *label) {
  dotH(0, 127, 53);
  oled.setFont(u8g2_font_5x7_tf);
  if (talker[0]) {
    char b[28]; snprintf(b, sizeof b, "TX %s", talker);
    oled.setDrawColor(1); oled.drawBox(0, 55, oled.getUTF8Width(b) + 4, 9); oled.setDrawColor(0);
    oled.drawUTF8(2, 62, b); oled.setDrawColor(1);
  } else if (label && label[0]) {
    oled.setFont(u8g2_font_6x12_te); diamond(3, 59, 2, false); oled.drawUTF8(8, 63, label);
  }
  oled.setFont(u8g2_font_4x6_tf);
  if (!connected) { if (blink(400)) oled.drawStr(94, 62, "NO LNK"); }
  else if (!calibrated && blink(600)) oled.drawStr(98, 62, "CAL!");
  else oled.drawStr(98, 62, "LNK");
  int pc = battPct();
  if (pc >= 0 && (pc >= 15 || blink(400))) {                 // 4 baterijos stulpeliai
    for (int i = 0; i < 4; i++) { int hgt = 2 + i * 2; if (pc > i * 25) oled.drawBox(112 + i * 4, 63 - hgt, 3, hgt); else oled.drawFrame(112 + i * 4, 63 - hgt, 3, hgt); }
  }
}

void drawRadar(bool navFresh) {
  const int cx = 31, cy = 32, R = 30;
  float maxd = 0;
  for (int i = 0; i < memN; i++) maxd = max(maxd, mem[i].dist);
  if (navFresh) maxd = max(maxd, nav.dist);
  static const int scales[] = {50, 100, 250, 500, 1000, 2000, 5000};
  int sc = 5000;
  for (int v : scales) if (v >= maxd * 1.1f) { sc = v; break; }
  oled.drawCircle(cx, cy, R);
  for (int a = 0; a < 360; a += 12) oled.drawPixel(cx + (int)lroundf(cosf(a * PI / 180) * R / 2), cy + (int)lroundf(sinf(a * PI / 180) * R / 2));
  dotH(cx - R + 2, cx + R - 2, cy); dotV(cx, cy - R + 2, cy + R - 2);
  float sw = (millis() % 2400) / 2400.0f * 2 * PI;          // besisukantis spindulys
  oled.drawLine(cx, cy, cx + (int)lroundf(sinf(sw) * (R - 1)), cy - (int)lroundf(cosf(sw) * (R - 1)));
  oled.drawTriangle(cx - 2, cy + 2, cx + 2, cy + 2, cx, cy - 3);
  if (headingOk) {
    float a = -heading * PI / 180.0f;
    oled.setFont(u8g2_font_4x6_tf); oled.drawStr(cx + (int)lroundf(sinf(a) * (R - 5)) - 1, cy - (int)lroundf(cosf(a) * (R - 5)) + 3, "N");
  }
  auto pos = [&](float brg, float dist, int &x, int &y, bool &edge) {
    float r = dist / sc * R; edge = r > R - 2; if (edge) r = R - 2;
    float a = (brg - (headingOk ? heading : 0)) * PI / 180.0f;
    x = cx + (int)lroundf(sinf(a) * r); y = cy - (int)lroundf(cosf(a) * r);
  };
  int nearest = -1;
  for (int i = 0; i < memN; i++) {
    int x, y; bool e; pos(mem[i].brg, mem[i].dist, x, y, e);
    if (e) oled.drawFrame(x - 1, y - 1, 3, 3); else oled.drawBox(x - 1, y - 1, 3, 3);
    if (nearest < 0 || mem[i].dist < mem[nearest].dist) nearest = i;
  }
  if (navFresh) { int x, y; bool e; pos(nav.brg, nav.dist, x, y, e); diamond(x, y, 3, blink(250)); }
  if (nearest >= 0) { int x, y; bool e; pos(mem[nearest].brg, mem[nearest].dist, x, y, e); brackets(x - 4, y - 4, x + 4, y + 4, 3); }
  // dešinė pusė
  char num[12], b[32]; const char *u;
  oled.setFont(u8g2_font_4x6_tf); oled.drawStr(68, 6, "PPI"); dotV(66, 0, 52);
  fmtRng(sc, num, &u); snprintf(b, sizeof b, "R %s%s", num, u); oled.drawStr(127 - oled.getStrWidth(b), 6, b);
  if (nearest >= 0) {
    oled.setFont(u8g2_font_4x6_tf); oled.drawStr(68, 17, "NEAR");
    oled.setFont(u8g2_font_7x13B_tf); oled.drawUTF8(68, 30, mem[nearest].ini);
    fmtRng(mem[nearest].dist, num, &u); snprintf(b, sizeof b, "%s%s", num, u);
    oled.setFont(u8g2_font_6x10_tf); oled.drawStr(127 - oled.getStrWidth(b), 30, b);
  }
  if (navFresh) {
    oled.setFont(u8g2_font_4x6_tf); oled.drawStr(68, 40, "TGT");
    fmtRng(nav.dist, num, &u); snprintf(b, sizeof b, "%s%s", num, u);
    oled.setFont(u8g2_font_6x10_tf); diamond(71, 47, 2, true); oled.drawStr(127 - oled.getStrWidth(b), 51, b);
  }
  char cnt[12]; snprintf(cnt, sizeof cnt, "%d", memN); oled.setFont(u8g2_font_4x6_tf); oled.drawStr(84, 17, "x"); oled.drawStr(88, 17, cnt);
  drawBottom(nullptr);
}

void drawNav() {
  uint32_t now = millis();
  bool fresh = connected && nav.has && now - nav.at < 30000;
  bool memFresh = connected && memN > 0 && now - memAt < 30000;
  if (memFresh && (viewMode == 1 || !fresh)) { drawRadar(fresh); return; }
  drawTape(fresh, nav.brg);
  char b[24], num[12]; const char *u;
  // kairė: kryptis
  oled.setFont(u8g2_font_4x6_tf); oled.drawStr(0, 25, "HDG");
  oled.setFont(u8g2_font_7x13B_tf);
  if (headingOk) { snprintf(b, sizeof b, "%03d", (int)lroundf(heading) % 360); oled.drawStr(0, 38, b); oled.drawCircle(23, 29, 1); }
  else oled.drawStr(0, 38, imuOk ? "---" : "IMU!");
  // centras: taikiklis
  brackets(42, 20, 86, 50, 6);
  if (fresh && nav.dist < 25) {                               // atvykai
    bool on = blink(300);
    if (on) oled.drawBox(46, 24, 37, 23);
    oled.setDrawColor(on ? 0 : 1); oled.setFont(u8g2_font_7x13B_tf); oled.drawStr(50, 35, "ON"); oled.drawStr(50, 45, "TGT"); oled.setDrawColor(1);
  } else if (fresh && headingOk) {
    drawArrow(64, 35, 12, wrap180(nav.brg - heading));
    oled.drawPixel(64, 35);
  } else {
    oled.drawHLine(58, 35, 13); oled.drawVLine(64, 29, 13);  // kryželis
    oled.setFont(u8g2_font_4x6_tf); oled.drawStr(54, 48, fresh ? "IMU?" : "NO TGT");
  }
  // dešinė: atstumas ir azimutas
  if (fresh) {
    oled.setFont(u8g2_font_4x6_tf); oled.drawStr(91, 25, "RNG");
    fmtRng(nav.dist, num, &u);
    oled.setFont(u8g2_font_logisoso16_tr); int w = oled.getStrWidth(num);
    if (w > 36) { oled.setFont(u8g2_font_7x13B_tf); w = oled.getStrWidth(num); }
    oled.drawStr(127 - w, 41, num);
    oled.setFont(u8g2_font_4x6_tf); oled.drawStr(127 - oled.getStrWidth(u), 48, u);
    if (now - nav.at > 8000 && blink(400)) oled.drawStr(91, 48, "OLD");
    oled.setFont(u8g2_font_4x6_tf); snprintf(b, sizeof b, "BRG %03d", (int)lroundf(nav.brg) % 360); oled.drawStr(0, 48, b);
  } else {
    oled.setFont(u8g2_font_4x6_tf); oled.drawStr(91, 25, "RNG"); oled.setFont(u8g2_font_7x13B_tf); oled.drawStr(100, 41, "---");
  }
  char t[16] = ""; if (fresh) copyStr(t, nav.title, sizeof t);
  drawBottom(fresh ? t : (connected ? "" : nullptr));
}

void drawMsg() {
  oled.drawFrame(0, 0, 128, 64);
  oled.setDrawColor(1); oled.drawBox(0, 0, 128, 11); oled.setDrawColor(0);
  oled.setFont(u8g2_font_5x7_tf); oled.drawStr(2, 8, "MSG");
  oled.setFont(u8g2_font_6x12_te); char b[40]; snprintf(b, sizeof b, "// %s", msgFrom[0] ? msgFrom : "311");
  oled.drawUTF8(22, 9, b); oled.setDrawColor(1);
  oled.setFont(u8g2_font_9x15_te);
  if (wrapDraw(msgText, 4, 28, 120, 16, 3) >= 3 && strlen(msgText) > 36) {
    oled.setDrawColor(0); oled.drawBox(1, 12, 126, 51); oled.setDrawColor(1);
    oled.setFont(u8g2_font_6x12_te); wrapDraw(msgText, 4, 24, 120, 12, 4);
  }
}

void drawAlarm() {
  bool inv = blink(300);
  // įspėjamosios juostos kraštuose
  for (int x = -8; x < 136; x += 8) { oled.drawLine(x, 0, x + 6, 6); oled.drawLine(x + 1, 0, x + 7, 6); oled.drawLine(x, 57, x + 6, 63); oled.drawLine(x + 1, 57, x + 7, 63); }
  if (inv) { oled.drawBox(0, 8, 128, 48); oled.setDrawColor(0); }
  bool isStop = strstr(alarmText, "STOP") || strstr(alarmText, "stop") || strstr(alarmText, "Stop");
  if (isStop) {
    oled.setFont(u8g2_font_logisoso32_tr); oled.drawStr((128 - oled.getStrWidth("STOP")) / 2, 45, "STOP");
    oled.setFont(u8g2_font_4x6_tf); oled.drawStr(2, 16, "!! ALERT"); oled.drawStr(126 - oled.getStrWidth("ALL STOP !!"), 16, "ALL STOP !!");
  } else {
    oled.setFont(u8g2_font_9x15_te); wrapDraw(alarmText, 4, 24, 120, 15, 2);
  }
  oled.setFont(u8g2_font_6x12_te); char b[40]; snprintf(b, sizeof b, "FROM %s", alarmFrom);
  oled.drawUTF8((128 - oled.getUTF8Width(b)) / 2, 54, b);
  oled.setDrawColor(1);
}

void drawBoot(uint32_t t) {                                   // paleidimo ekranas
  oled.clearBuffer();
  brackets(0, 0, 127, 63, 8);
  oled.setFont(u8g2_font_7x13B_tf); oled.drawStr(18, 17, "311 VOICECH");
  oled.setFont(u8g2_font_4x6_tf); oled.drawStr(36, 25, "HUD MK2 // v" FW_VER);
  oled.drawStr(8, 38, "IMU"); oled.drawStr(8, 46, "BLE"); oled.drawStr(8, 54, "BAT");
  oled.drawStr(30, 38, t > 1 ? (imuOk ? "OK" : "--") : "..");
  oled.drawStr(30, 46, t > 2 ? "ADV" : "..");
  oled.drawStr(30, 54, t > 3 ? (battMv ? "OK" : "N/A") : "..");
  oled.drawFrame(60, 40, 60, 7); oled.drawBox(62, 42, min<int>(56, t * 14), 3);
  oled.sendBuffer();
}

// ---------------- pagrindinis ----------------
void setup() {
  Serial.begin(115200);
  pinMode(PIN_BAT, INPUT);
  pinMode(PIN_BTN, INPUT_PULLUP);
  analogReadResolution(12);
  loadPrefs();

  Wire.begin();
  Wire.setClock(400000);
  oled.setBusClock(400000);
  oled.begin();
  oled.enableUTF8Print();
  applyDisplay();
  drawBoot(0);
  imuBegin(); drawBoot(2);

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
  battPoll(); drawBoot(3); delay(300); drawBoot(4); delay(500);
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

  // PTT mygtukas (su 25 ms apsauga nuo kontaktų „šokinėjimo“)
  static uint32_t btnChange = 0; static bool btnRaw = false;
  bool raw = digitalRead(PIN_BTN) == LOW;
  if (raw != btnRaw) { btnRaw = raw; btnChange = millis(); }
  if (raw != btnDown && millis() - btnChange > 25) {
    btnDown = raw;
    if (connected && txC) { const char *b = btnDown ? "B|1" : "B|0"; txC->setValue((uint8_t *)b, 3); txC->notify(); }
  }

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
  if (btnDown) {                                       // kalbi – žymė viršuje kairėje
    oled.setDrawColor(0); oled.drawBox(40, 54, 48, 10); oled.setDrawColor(1); oled.drawFrame(40, 54, 48, 10);
    oled.setFont(u8g2_font_5x7_tf); oled.drawStr(44, 62, connected ? (blink(250) ? "* TX *" : "  TX  ") : "NO LNK");
  }
  oled.sendBuffer();
}
