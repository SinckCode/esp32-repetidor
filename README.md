# Repetidor WiFi ESP32-C5 + telemetría

Un **ESP32-C5** clona la MAC de un equipo autorizado en una **red que filtra por
MAC** y actúa como **repetidor con NAT**, de modo que tu laptop y tu celular
navegan a través de él. Sirve para **cualquier red que haga filtrado por dirección
MAC**: el ESP se presenta con la MAC del dispositivo permitido y reparte internet a
sus propios clientes. Además envía telemetría a un servidor propio con dashboard.

> Pensado para redes **propias o donde tengas autorización** (tu casa, tu
> laboratorio, una práctica). Clonar la MAC de un equipo que no es tuyo en una red
> ajena puede violar sus normas de uso.

## Cómo funciona

- **STA**: el ESP se conecta a la red restringida usando la MAC del dispositivo
  autorizado (clonada).
- **AP**: crea su propia red (por defecto `iPhone 16`, un nombre discreto) para la
  laptop y el celular.
- **NAPT**: enruta (NAT) el tráfico entre su AP y la red restringida → todos navegan.

Como la laptop se conecta al **AP del ESP** (no directo a la red restringida), la
única MAC que aparece en esa red es la del ESP32 clonada, y se evita el conflicto de
"dos equipos con la misma MAC".

## Partes

| Carpeta / archivo | Qué es |
|---|---|
| `WifiESP32Mac.ino` | Firmware Arduino del ESP32-C5: `WIFI_AP_STA`, clona la MAC, se conecta a la red restringida, levanta su AP, activa NAPT y envía telemetría cada 30 s por HTTPS. |
| `server/` | API Node (Express) que recibe la telemetría y la muestra en un dashboard con login. Ver [`server/README.md`](server/README.md). |
| `.github/workflows/deploy.yml` | Ejemplo de CI/CD: en push a `main` le pide a una deploy-API que despliegue `server/`. Adáptalo a tu propia infraestructura. |

## Arquitectura

```
ESP32-C5  ──(STA, red con filtro MAC)──▶  router  ──▶  internet
   │                                                     │
   └──(AP "iPhone 16" + NAT)──▶ laptop/celular
   │
   └──HTTPS POST cada 30s──▶ tu servidor  ──▶  dashboard
```

El firmware y el servidor son **dos cosas distintas**: el `.ino` corre en la placa;
`server/` corre en tu servidor. El token (`DEVICE_TOKEN`) tiene que ser el mismo en
ambos.

## Configurar y usar

1. En `WifiESP32Mac.ino`, rellena el bloque **CONFIGURA ESTO**:
   - `STA_SSID` / `STA_PASS`: la red con filtro por MAC a la que te conectas.
   - `CLONE_MAC[6]`: la MAC del dispositivo que esa red **ya deja pasar**.
   - `AP_SSID` / `AP_PASS`: el nombre y clave de la red que creará el ESP.
   - `SERVER_URL` / `DEVICE_TOKEN`: tu servidor de telemetría (opcional; ver `server/`).
2. Compila y sube el sketch (ESP32 Arduino core 3.x). Si tu red es de 5 GHz necesitas
   el **ESP32-C5**; si es solo 2.4 GHz sirve un ESP32 clásico.
3. Conecta tu laptop y tu celular al AP del ESP.
4. (Opcional) Despliega `server/` para ver la telemetría en el dashboard.

## Seguridad

- El firmware lleva la clave WiFi y el `DEVICE_TOKEN` **compilados**. No publiques un
  binario ni subas tus valores reales: deja los marcadores de posición en el repo y
  rellénalos solo en tu copia local antes de flashear.
- El `.env` del servidor (token, usuario, clave) **no** se versiona (ver `.gitignore`).
