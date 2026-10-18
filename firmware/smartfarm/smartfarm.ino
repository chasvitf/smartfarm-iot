// SmartFarm: greenhouse controller on an ESP32.
// Reads air temperature / humidity (DHT22), soil moisture and light, runs the
// pump and fan automatically (or by hand from the dashboard), shows everything
// on a 128x64 OLED and talks to the web dashboard over MQTT with TLS.
//
// MQTT topics (base = smartfarm-th/<DEVICE_ID>):
//   base/state    every 5 s, retained   {"ts":1792325000,"t":28.4,"h":61,"soil":42,"light":70,"pump":false,"fan":true,...}
//   base/status   retained, LWT         "online" / "offline"
//   base/history  every minute, retained [[ts,t,h,soil,light,pumpPct], ...] last 60 minutes
//   base/config   retained              {"mode":"auto","soilMin":35,"tempMax":32}
//   base/cmd      dashboard -> device   {"mode":"manual"} {"pump":true} {"fan":false} {"soilMin":40} {"tempMax":30}

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <DHTesp.h>
#include <Preferences.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <time.h>

#include "config.h"
#include "certs.h"
#include "control.h"

using smartfarm::Controller;
using smartfarm::Outputs;
using smartfarm::Readings;
using smartfarm::Settings;

static const char* kFirmware = "1.0.0";

static const String kBase = String("smartfarm-th/") + DEVICE_ID;
static const String kTopicState = kBase + "/state";
static const String kTopicStatus = kBase + "/status";
static const String kTopicHistory = kBase + "/history";
static const String kTopicConfig = kBase + "/config";
static const String kTopicCmd = kBase + "/cmd";

WiFiClientSecure tls;
PubSubClient mqtt(tls);
DHTesp dht;
Preferences prefs;
Adafruit_SSD1306 oled(128, 64, &Wire, -1);
bool oledOk = false;

Controller controller;
Settings settings;
Readings readings;
Outputs outputs;

// One averaged point per minute for the dashboard chart.
struct Sample { uint32_t ts; float t, h, soil, light, pump; };
constexpr int kHistory = 60;
Sample history[kHistory];
int historyCount = 0;
Sample acc = {0, 0, 0, 0, 0, 0};
int accN = 0;

uint32_t lastSensor = 0, lastPublish = 0, lastHistory = 0, lastMqttTry = 0, lastWifiTry = 0;
uint32_t mqttRetryMs = 2000;
bool configDirty = true;
bool clockStarted = false;

// Unix time once NTP has answered, 0 before that.
uint32_t nowEpoch() {
  time_t t = time(nullptr);
  return t > 1700000000 ? uint32_t(t) : 0;
}

// ---------- outputs ----------

void writeRelay(int pin, bool on) {
  digitalWrite(pin, (on ^ RELAY_ACTIVE_LOW) ? HIGH : LOW);
}

void applyOutputs() {
  writeRelay(PIN_PUMP, outputs.pump);
  writeRelay(PIN_FAN, outputs.fan);
  digitalWrite(PIN_PUMP_LED, outputs.pump);
  digitalWrite(PIN_FAN_LED, outputs.fan);
}

// ---------- settings (kept in flash across restarts) ----------

void loadSettings() {
  prefs.begin("smartfarm", true);
  int soilMin = prefs.getInt("soilMin", settings.soilMin);
  float tempMax = prefs.getFloat("tempMax", settings.tempMax);
  settings.autoMode = prefs.getBool("auto", settings.autoMode);
  prefs.end();
  if (smartfarm::settingsValid(soilMin, tempMax)) {
    settings.soilMin = soilMin;
    settings.tempMax = tempMax;
  }
}

void saveSettings() {
  prefs.begin("smartfarm", false);
  prefs.putInt("soilMin", settings.soilMin);
  prefs.putFloat("tempMax", settings.tempMax);
  prefs.putBool("auto", settings.autoMode);
  prefs.end();
  configDirty = true;
}

void setAutoMode(bool on) {
  if (settings.autoMode == on) return;
  settings.autoMode = on;
  // Switching to manual keeps whatever is running, so nothing jumps.
  if (!on) controller.setManual(outputs.pump, outputs.fan);
  saveSettings();
  Serial.printf("mode -> %s\n", on ? "auto" : "manual");
}

// ---------- sensors ----------

void readSensors() {
  TempAndHumidity th = dht.getTempAndHumidity();
  readings.valid = dht.getStatus() == DHTesp::ERROR_NONE && !isnan(th.temperature) && !isnan(th.humidity);
  if (readings.valid) {
    readings.temp = th.temperature;
    readings.hum = th.humidity;
  }
  readings.soil = smartfarm::rawToPercent(analogRead(PIN_SOIL), SOIL_RAW_DRY, SOIL_RAW_WET);
  readings.light = smartfarm::rawToPercent(analogRead(PIN_LIGHT), LIGHT_RAW_DARK, LIGHT_RAW_BRIGHT);

  if (readings.valid) {
    acc.t += readings.temp;
    acc.h += readings.hum;
    acc.soil += readings.soil;
    acc.light += readings.light;
    acc.pump += outputs.pump ? 100 : 0;
    accN++;
  }
}

void pushHistory() {
  if (!accN) return;
  Sample s = {nowEpoch(), acc.t / accN, acc.h / accN, acc.soil / accN, acc.light / accN, acc.pump / accN};
  if (historyCount < kHistory) {
    history[historyCount++] = s;
  } else {
    memmove(history, history + 1, sizeof(Sample) * (kHistory - 1));
    history[kHistory - 1] = s;
  }
  acc = {0, 0, 0, 0, 0, 0};
  accN = 0;
}

// ---------- MQTT ----------

void publishJson(const String& topic, JsonDocument& doc, bool retained) {
  String out;
  serializeJson(doc, out);
  if (!mqtt.publish(topic.c_str(), out.c_str(), retained)) Serial.printf("publish failed: %s\n", topic.c_str());
}

void publishState() {
  JsonDocument doc;
  if (nowEpoch()) doc["ts"] = nowEpoch();
  if (readings.valid) {
    doc["t"] = round(readings.temp * 10) / 10.0;
    doc["h"] = round(readings.hum);
  }
  doc["sensorOk"] = readings.valid;
  doc["soil"] = readings.soil;
  doc["light"] = readings.light;
  doc["pump"] = outputs.pump;
  doc["fan"] = outputs.fan;
  doc["pumpResting"] = outputs.pumpResting;
  doc["mode"] = settings.autoMode ? "auto" : "manual";
  doc["rssi"] = WiFi.RSSI();
  doc["uptime"] = millis() / 1000;
  doc["fw"] = kFirmware;
  publishJson(kTopicState, doc, true);
}

void publishConfig() {
  JsonDocument doc;
  doc["mode"] = settings.autoMode ? "auto" : "manual";
  doc["soilMin"] = settings.soilMin;
  doc["tempMax"] = settings.tempMax;
  publishJson(kTopicConfig, doc, true);
  configDirty = false;
}

void publishHistory() {
  JsonDocument doc;
  JsonArray rows = doc.to<JsonArray>();
  for (int i = 0; i < historyCount; i++) {
    JsonArray r = rows.add<JsonArray>();
    r.add(history[i].ts);
    r.add(round(history[i].t * 10) / 10.0);
    r.add(round(history[i].h));
    r.add(round(history[i].soil));
    r.add(round(history[i].light));
    r.add(round(history[i].pump));
  }
  publishJson(kTopicHistory, doc, true);
}

void onCommand(char* topic, byte* payload, unsigned int len) {
  JsonDocument doc;
  if (deserializeJson(doc, payload, len)) {
    Serial.println("bad command json");
    return;
  }
  Serial.printf("cmd %.*s\n", len, (const char*)payload);
  if (doc["mode"].is<const char*>()) setAutoMode(strcmp(doc["mode"], "auto") == 0);
  if (!settings.autoMode && (doc["pump"].is<bool>() || doc["fan"].is<bool>())) {
    bool pump = doc["pump"].is<bool>() ? doc["pump"].as<bool>() : controller.pumpWanted();
    bool fan = doc["fan"].is<bool>() ? doc["fan"].as<bool>() : controller.fanWanted();
    controller.setManual(pump, fan);
  }
  int soilMin = doc["soilMin"] | settings.soilMin;
  float tempMax = doc["tempMax"] | settings.tempMax;
  if ((soilMin != settings.soilMin || tempMax != settings.tempMax) && smartfarm::settingsValid(soilMin, tempMax)) {
    settings.soilMin = soilMin;
    settings.tempMax = tempMax;
    saveSettings();
  }
  configDirty = true;
  // React at once instead of waiting for the next sensor tick.
  outputs = controller.update(readings, settings, millis());
  applyOutputs();
  publishState();
}

void ensureMqtt() {
  if (mqtt.connected() || WiFi.status() != WL_CONNECTED) return;
  if (millis() - lastMqttTry < mqttRetryMs) return;
  lastMqttTry = millis();
  String clientId = String("smartfarm-") + DEVICE_ID + "-" + String((uint32_t)ESP.getEfuseMac(), HEX);
  Serial.printf("MQTT connecting to %s:%d ... ", MQTT_HOST, MQTT_PORT);
  bool ok = strlen(MQTT_USER)
    ? mqtt.connect(clientId.c_str(), MQTT_USER, MQTT_PASS, kTopicStatus.c_str(), 1, true, "offline")
    : mqtt.connect(clientId.c_str(), kTopicStatus.c_str(), 1, true, "offline");
  if (!ok) {
    Serial.printf("failed, state %d\n", mqtt.state());
    mqttRetryMs = min<uint32_t>(mqttRetryMs * 2, 30000);  // back off up to 30 s
    return;
  }
  Serial.println("connected");
  mqttRetryMs = 2000;
  mqtt.publish(kTopicStatus.c_str(), "online", true);
  mqtt.subscribe(kTopicCmd.c_str(), 1);
  publishConfig();
  publishHistory();
}

void ensureWifi() {
  if (WiFi.status() == WL_CONNECTED) {
    if (!clockStarted) {
      clockStarted = true;
      configTzTime("ICT-7", "pool.ntp.org", "time.google.com");  // Thailand, UTC+7
    }
    return;
  }
  if (millis() - lastWifiTry < 20000 && lastWifiTry) return;  // give a slow DHCP time before retrying
  lastWifiTry = millis();
  Serial.printf("WiFi connecting to %s\n", WIFI_SSID);
  WiFi.disconnect();
  WiFi.begin(WIFI_SSID, WIFI_PASS, WIFI_CHANNEL);
}

// ---------- OLED ----------

void drawScreen() {
  if (!oledOk) return;
  oled.clearDisplay();
  oled.setTextColor(SSD1306_WHITE);
  oled.setTextSize(1);
  oled.setCursor(0, 0);
  oled.print("SmartFarm");
  oled.setCursor(104, 0);  // 4 characters, right-aligned on the 128 px line
  oled.print(WiFi.status() == WL_CONNECTED ? (mqtt.connected() ? "LIVE" : "WIFI") : "----");
  oled.drawFastHLine(0, 10, 128, SSD1306_WHITE);

  oled.setCursor(0, 15);
  if (readings.valid) oled.printf("Air  %4.1fC  %3.0f%%", readings.temp, readings.hum);
  else oled.print("Air  sensor error");
  oled.setCursor(0, 26);
  oled.printf("Soil %3d%%  Light %3d%%", readings.soil, readings.light);
  oled.setCursor(0, 37);
  oled.printf("Pump %s  Fan %s", outputs.pump ? "ON " : (outputs.pumpResting ? "REST" : "off"), outputs.fan ? "ON" : "off");
  oled.drawFastHLine(0, 49, 128, SSD1306_WHITE);
  oled.setCursor(0, 54);
  oled.printf("%s  soil<%d%% t>%.0fC", settings.autoMode ? "AUTO" : "MAN ", settings.soilMin, settings.tempMax);
  oled.display();
}

// ---------- button ----------

void checkButton() {
  static bool last = HIGH;
  static uint32_t changed = 0;
  bool now = digitalRead(PIN_BUTTON);
  if (now != last && millis() - changed > 40) {
    changed = millis();
    last = now;
    if (now == LOW) {
      setAutoMode(!settings.autoMode);
      outputs = controller.update(readings, settings, millis());
      applyOutputs();
      drawScreen();
      if (mqtt.connected()) publishState();
    }
  }
}

// ---------- main ----------

void setup() {
  Serial.begin(115200);
  pinMode(PIN_PUMP, OUTPUT);
  pinMode(PIN_FAN, OUTPUT);
  pinMode(PIN_PUMP_LED, OUTPUT);
  pinMode(PIN_FAN_LED, OUTPUT);
  pinMode(PIN_BUTTON, INPUT_PULLUP);
  applyOutputs();  // everything off until the first reading
  analogReadResolution(12);

  loadSettings();
  dht.setup(PIN_DHT, DHTesp::DHT22);
  oledOk = oled.begin(SSD1306_SWITCHCAPVCC, 0x3C);
  if (!oledOk) Serial.println("OLED not found");

  WiFi.mode(WIFI_STA);
  tls.setCACert(kRootCA);
  // Short network timeouts: a broker that does not answer must not stall the
  // control loop (and the pump safety timer) for long.
  tls.setHandshakeTimeout(5);
  mqtt.setSocketTimeout(5);
  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setCallback(onCommand);
  mqtt.setBufferSize(4096);  // the history message is about 2 KB
  mqtt.setKeepAlive(30);
  Serial.printf("SmartFarm %s starting\n", DEVICE_ID);
}

void loop() {
  ensureWifi();
  ensureMqtt();
  mqtt.loop();
  checkButton();

  uint32_t now = millis();
  if (now - lastSensor >= SENSOR_PERIOD_MS || !lastSensor) {
    lastSensor = now;
    readSensors();
    Outputs before = outputs;
    outputs = controller.update(readings, settings, now);
    applyOutputs();
    if (before.pump != outputs.pump || before.fan != outputs.fan) {
      Serial.printf("pump %d fan %d (t=%.1f soil=%d)\n", outputs.pump, outputs.fan, readings.temp, readings.soil);
      if (mqtt.connected()) publishState();
    }
    drawScreen();
  }
  if (mqtt.connected()) {
    if (now - lastPublish >= PUBLISH_PERIOD_MS) {
      lastPublish = now;
      publishState();
    }
    if (configDirty) publishConfig();
    if (now - lastHistory >= HISTORY_PERIOD_MS) {
      lastHistory = now;
      pushHistory();
      publishHistory();
    }
  }
  delay(10);
}
