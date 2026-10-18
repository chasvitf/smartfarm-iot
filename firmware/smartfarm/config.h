// Settings to change for a real installation. The defaults run as-is in the
// Wokwi simulator (Wokwi-GUEST is the simulator's open Wi-Fi with internet).
#pragma once

// Wi-Fi
#define WIFI_SSID "Wokwi-GUEST"
#define WIFI_PASS ""
#define WIFI_CHANNEL 6  // Wokwi-GUEST is on channel 6; use 0 (scan all) on real hardware

// MQTT broker. broker.emqx.io is a free public broker: fine for a demo, but
// anyone can read or publish on it. Use a private broker with a user and
// password (EMQX Cloud, HiveMQ Cloud, Mosquitto) for a real farm.
#define MQTT_HOST "broker.emqx.io"
#define MQTT_PORT 8883  // MQTT over TLS
#define MQTT_USER ""
#define MQTT_PASS ""

// Topics are smartfarm-th/<DEVICE_ID>/{state,status,history,config,cmd}.
#define DEVICE_ID "demo-01"

// Pins (ESP32 DevKit)
#define PIN_DHT 15
#define PIN_SOIL 34    // ADC1, capacitive soil moisture sensor (a slider in Wokwi)
#define PIN_LIGHT 35   // ADC1, LDR module analog out
#define PIN_PUMP 26    // relay for the water pump
#define PIN_FAN 27     // relay for the fan
#define PIN_PUMP_LED 25
#define PIN_FAN_LED 33
#define PIN_BUTTON 4   // auto / manual, to GND
#define RELAY_ACTIVE_LOW false  // most blue relay boards switch on LOW: set true for those

// Sensor calibration: raw ADC values at 0 % and 100 %.
// Measure your soil sensor in dry air and in a glass of water and put the numbers here.
#define SOIL_RAW_DRY 3200
#define SOIL_RAW_WET 1300
#define LIGHT_RAW_DARK 4095
#define LIGHT_RAW_BRIGHT 0

// Timing
#define SENSOR_PERIOD_MS 2000     // DHT22 needs at least 2 s between reads
#define PUBLISH_PERIOD_MS 5000
#define HISTORY_PERIOD_MS 60000   // one averaged point per minute, last 60 kept
