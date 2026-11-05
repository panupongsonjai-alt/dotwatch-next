// dotWatch slice 1 firmware (ESP32) — device contract v1, see packages/shared/src/ingest.ts
//   POST /v1/ingest   Authorization: Device <code>:<secret>
//   {"fw":"...","readings":[{"t":<epoch ms>,"m":{"temperature":4.2,"humidity":61}}]}
// Fixes old 6.2: one client, one TLS session, kept alive between batches.
// Libraries: ArduinoJson 7.x (+ "DHT sensor library" by Adafruit if DHT_PIN is set)

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <time.h>
#include "config.h"
#ifdef DHT_PIN
#include <DHT.h>
DHT dht(DHT_PIN, DHT22);
#endif

#define FW_VERSION "slice1-0.1.0"
#define QUEUE_MAX 360   // ~1 hour at 10 s; oldest dropped first

struct Reading { uint64_t t; float temperature; float humidity; };
Reading queue[QUEUE_MAX];
size_t qHead = 0, qCount = 0;

WiFiClient plainClient;
WiFiClientSecure tlsClient;
HTTPClient http;
const bool useTls = strncmp(API_BASE_URL, "https", 5) == 0;
bool credentialsRejected = false;
uint32_t lastSample = 0, lastSend = 0;

uint64_t nowEpochMs() {
  time_t s = time(nullptr);
  if (s < 1700000000) return 0;           // clock not synced yet → server stamps it
  return (uint64_t)s * 1000ULL + (millis() % 1000);
}

void push(const Reading& r) {
  size_t idx = (qHead + qCount) % QUEUE_MAX;
  if (qCount == QUEUE_MAX) { qHead = (qHead + 1) % QUEUE_MAX; qCount--; }
  queue[idx] = r;
  qCount++;
}

void drop(size_t n) { n = min(n, qCount); qHead = (qHead + n) % QUEUE_MAX; qCount -= n; }

void sample() {
#ifdef DHT_PIN
  float t = dht.readTemperature(), h = dht.readHumidity();
  if (isnan(t) || isnan(h)) return;      // skip bad reads instead of sending NaN
#else
  static float t = 4.0;
  t += (random(-20, 21) / 100.0f) + (4.0f - t) * 0.05f;
  float h = 60 + random(0, 50) / 10.0f;
#endif
  push({nowEpochMs(), t, h});
}

void sendBatch() {
  if (qCount == 0 || WiFi.status() != WL_CONNECTED || credentialsRejected) return;
  const size_t n = min(qCount, (size_t)50);

  JsonDocument doc;
  doc["fw"] = FW_VERSION;
  JsonArray arr = doc["readings"].to<JsonArray>();
  for (size_t i = 0; i < n; i++) {
    const Reading& r = queue[(qHead + i) % QUEUE_MAX];
    JsonObject o = arr.add<JsonObject>();
    if (r.t) o["t"] = r.t;
    o["m"]["temperature"] = round(r.temperature * 100) / 100.0;
    o["m"]["humidity"] = round(r.humidity * 10) / 10.0;
  }
  String body;
  serializeJson(doc, body);

  String url = String(API_BASE_URL) + "/v1/ingest";
  bool ok = useTls ? http.begin(tlsClient, url) : http.begin(plainClient, url);
  if (!ok) return;
  http.addHeader("Content-Type", "application/json");
  http.addHeader("Authorization", String("Device ") + DEVICE_CODE + ":" + DEVICE_SECRET);
  int code = http.POST(body);

  if (code == 200) {
    drop(n);                                // accepted and rejected readings both leave the queue
    Serial.printf("sent %u, queue %u\n", (unsigned)n, (unsigned)qCount);
  } else if (code == 400) {
    drop(n);                                // malformed batch will never succeed
    Serial.printf("400, dropped %u\n", (unsigned)n);
  } else if (code == 401) {
    credentialsRejected = true;             // stop hammering the server; fix config and reboot
    Serial.println("401: check DEVICE_CODE / DEVICE_SECRET");
  } else {
    Serial.printf("send failed (%d), keeping %u queued\n", code, (unsigned)qCount);
    http.end();                             // drop a broken connection; next begin() reconnects
    return;
  }
  // keep-alive: no http.end() on success, the TLS session is reused next time
}

void setup() {
  Serial.begin(115200);
#ifdef DHT_PIN
  dht.begin();
#endif
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  configTime(0, 0, "pool.ntp.org", "time.google.com");
  if (useTls) {
    if (strlen(ROOT_CA) > 0) tlsClient.setCACert(ROOT_CA);
    else Serial.println("WARNING: https without ROOT_CA is not allowed; set ROOT_CA in config.h");
  }
  http.setReuse(true);
  http.setTimeout(8000);
}

void loop() {
  uint32_t ms = millis();
  if (ms - lastSample >= SAMPLE_SECONDS * 1000UL) { lastSample = ms; sample(); }
  if (ms - lastSend >= SEND_SECONDS * 1000UL) { lastSend = ms; sendBatch(); }
  delay(20);
}
