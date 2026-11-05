// Copy to config.h (gitignored) and fill in.
#pragma once

#define WIFI_SSID      "your-wifi"
#define WIFI_PASSWORD  "your-password"

// Local test: http://<your PC's LAN IP>:4000   Production: https://api.your-domain
#define API_BASE_URL   "http://192.168.1.10:4000"

// From `npm run db:seed` (services/api/.demo-device.json) or POST /v1/devices
#define DEVICE_CODE    "DEMO-001"
#define DEVICE_SECRET  "paste-secret-here"

#define SAMPLE_SECONDS 10   // read the sensor this often
#define SEND_SECONDS   30   // send a batch this often (one TLS connection is reused)

// Uncomment if a DHT22 is wired to this pin; otherwise values are simulated.
// #define DHT_PIN 4

// For https:// URLs paste the root CA of your API host (PEM). Leave empty for http:// on a LAN.
static const char ROOT_CA[] = "";
