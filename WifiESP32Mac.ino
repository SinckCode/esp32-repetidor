/*
 * ESP32-C5 - Repetidor WiFi con NAT + clonado de MAC
 * --------------------------------------------------
 * STA : se conecta a la red restringida usando la MAC del dispositivo autorizado.
 * AP  : crea una red propia para la laptop y el celular.
 * NAPT: enruta (NAT) el trafico entre el AP y la red restringida -> ambos navegan.
 *
 * Diseno: la laptop autorizada se conecta al AP del ESP32 (NO directo a RedRestringida),
 *         asi la unica MAC que aparece en la red restringida es la del ESP32 clonada,
 *         y se evita el conflicto de "dos equipos con la misma MAC".
 *
 * Requisitos:
 *   - ESP32 Arduino core 3.x  (Gestor de placas: "esp32" by Espressif)
 *   - Placa: ESP32-C5 (doble banda). RedRestringida es de 5 GHz (canales 44/64),
 *     por eso se usa el C5 y no el ESP32 clasico (que solo hace 2.4 GHz).
 */

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include "esp_wifi.h"
#include "esp_netif.h"

// ---------------- CONFIGURA ESTO ----------------
const char* STA_SSID = "RedRestringida";          // red restringida (RedRestringida, banda 5 GHz)
const char* STA_PASS = "***CLAVE_RETIRADA***";  // contrasena WPA2 de RedRestringida

const char* AP_SSID  = "ESP32-Extender";      // red que creara el ESP32
const char* AP_PASS  = "clave12345";          // minimo 8 caracteres

// MAC del dispositivo autorizado a clonar (la de tu laptop: 00:11:22:33:44:55)
uint8_t CLONE_MAC[6] = {0x00, 0x11, 0x22, 0x33, 0x44, 0x55};

// ---- Telemetria al servidor (dashboard) ----
// URL publica de tu API (tunel Cloudflare). Debe terminar en /api/telemetry
const char* SERVER_URL   = "https://esp32.angelonesto.com/api/telemetry";
// Token: tiene que ser IDENTICO a DEVICE_TOKEN del .env del servidor
const char* DEVICE_TOKEN = "***TOKEN_RETIRADO***";
const char* DEVICE_ID    = "esp32-c5-repetidor";
const char* FW_VERSION   = "1.0";
const unsigned long TELEMETRY_INTERVAL_MS = 30000;  // cada 30 s
// ------------------------------------------------

bool g_naptOk = false;   // resultado del NAPT, lo reporta la telemetria

void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println("\n== ESP32 repetidor con MAC clonada ==");

  WiFi.mode(WIFI_AP_STA);

  // 0) ESP32-C5: habilitar los canales de 5 GHz.
  //    Con ieee80211d=true el chip adopta la region que anuncia RedRestringida
  //    (canales 44/64). Ajusta "US" a tu pais si tu zona usa otro perfil.
  esp_err_t c = esp_wifi_set_country_code("US", true);
  Serial.printf("set_country: %s\n", esp_err_to_name(c));

  // 1) Clonar la MAC ANTES de conectar
  esp_err_t r = esp_wifi_set_mac(WIFI_IF_STA, CLONE_MAC);
  Serial.printf("set_mac STA: %s\n", esp_err_to_name(r));

  // 2) Conectar a la red restringida (espera acotada: si no engancha en 30 s,
  //    igual se levanta el AP y el loop sigue reintentando la conexion STA).
  WiFi.begin(STA_SSID, STA_PASS);
  Serial.printf("Conectando a %s", STA_SSID);
  unsigned long t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < 30000) { delay(500); Serial.print("."); }
  Serial.println();
  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("STA IP:  "); Serial.println(WiFi.localIP());
    Serial.print("STA MAC: "); Serial.println(WiFi.macAddress());  // debe mostrar 00:11:22:33:44:55
  } else {
    Serial.println("STA sin conexion aun; levanto el AP y el loop reintentara.");
  }

  // 3) Levantar el AP en una subred distinta a la de RedRestringida (192.168.1.x)
  WiFi.softAPConfig(IPAddress(192,168,4,1),
                    IPAddress(192,168,4,1),
                    IPAddress(255,255,255,0));
  WiFi.softAP(AP_SSID, AP_PASS);
  Serial.print("AP IP:   "); Serial.println(WiFi.softAPIP());

  esp_netif_t* ap_netif = WiFi.AP.netif();   // core 3.x

  // 4) Entregar un DNS publico a los clientes via DHCP (para resolver nombres)
  esp_netif_dns_info_t dns = {};
  dns.ip.type = ESP_IPADDR_TYPE_V4;
  dns.ip.u_addr.ip4.addr = esp_ip4addr_aton("8.8.8.8");
  uint8_t offer = 1;
  esp_netif_dhcps_stop(ap_netif);
  esp_netif_dhcps_option(ap_netif, ESP_NETIF_OP_SET,
                         ESP_NETIF_DOMAIN_NAME_SERVER, &offer, sizeof(offer));
  esp_netif_set_dns_info(ap_netif, ESP_NETIF_DNS_MAIN, &dns);
  esp_netif_dhcps_start(ap_netif);

  // 5) Activar NAT (NAPT) en la interfaz del AP
  esp_err_t n = esp_netif_napt_enable(ap_netif);
  g_naptOk = (n == ESP_OK);
  Serial.printf("NAPT: %s\n", esp_err_to_name(n));
  if (n != ESP_OK) {
    Serial.println(">> Si dice NOT_SUPPORTED, tu core no trae NAPT: actualiza a esp32 core 3.x");
  }

  Serial.println("Listo. Conecta la laptop y el celular al AP 'ESP32-Extender'.");
}

// Envia una muestra de telemetria al servidor (HTTPS POST con JSON).
// El ESP32 usa su interfaz STA (que ya tiene internet) para llegar a la URL publica.
void sendTelemetry() {
  if (WiFi.status() != WL_CONNECTED) return;  // sin internet no hay como enviar

  char body[512];
  snprintf(body, sizeof(body),
    "{\"device_id\":\"%s\",\"fw\":\"%s\",\"sta_connected\":%s,"
    "\"sta_mac\":\"%s\",\"sta_ip\":\"%s\",\"rssi\":%d,\"channel\":%d,"
    "\"ap_clients\":%d,\"napt_ok\":%s,\"uptime_s\":%lu,\"heap_free\":%u}",
    DEVICE_ID, FW_VERSION,
    (WiFi.status() == WL_CONNECTED) ? "true" : "false",
    WiFi.macAddress().c_str(),
    WiFi.localIP().toString().c_str(),
    WiFi.RSSI(), WiFi.channel(),
    WiFi.softAPgetStationNum(),
    g_naptOk ? "true" : "false",
    (unsigned long)(millis() / 1000),
    (unsigned)ESP.getFreeHeap());

  WiFiClientSecure client;
  client.setInsecure();   // practica: no validamos el cert del tunel (Cloudflare)
  HTTPClient https;
  if (!https.begin(client, SERVER_URL)) {
    Serial.println("telemetria: begin() fallo");
    return;
  }
  https.setTimeout(8000);
  https.addHeader("Content-Type", "application/json");
  https.addHeader("Authorization", String("Bearer ") + DEVICE_TOKEN);
  int code = https.POST((uint8_t*)body, strlen(body));
  Serial.printf("telemetria -> HTTP %d\n", code);
  https.end();
}

void loop() {
  static bool up = true;
  static unsigned long lastTelemetry = 0;

  if (WiFi.status() != WL_CONNECTED) {
    if (up) { Serial.println("STA caida, reintentando..."); up = false; }
    WiFi.reconnect();
    delay(1000);
  } else if (!up) {
    Serial.println("STA reconectada."); up = true;
    sendTelemetry();                 // avisa de inmediato que volvio
    lastTelemetry = millis();
  }

  // Enviar telemetria en el intervalo (o la primera vez tras arrancar)
  if (WiFi.status() == WL_CONNECTED &&
      (lastTelemetry == 0 || millis() - lastTelemetry >= TELEMETRY_INTERVAL_MS)) {
    sendTelemetry();
    lastTelemetry = millis();
  }

  delay(500);
}
