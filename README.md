# Repetidor WiFi ESP32-C5 + telemetría

Práctica de redes: un **ESP32-C5** clona la MAC de un equipo autorizado en la red
**RedRestringida** (que filtra por MAC, banda 5 GHz) y actúa como **repetidor con NAT**,
para que la laptop y el celular naveguen a través de él. Además envía telemetría a
un servidor propio con dashboard.

## Partes

| Carpeta / archivo | Qué es |
|---|---|
| `WifiESP32Mac.ino` | Firmware Arduino del ESP32-C5: `WIFI_AP_STA`, clona la MAC, conecta a RedRestringida (5 GHz), levanta el AP `ESP32-Extender`, activa NAPT y envía telemetría cada 30 s por HTTPS. |
| `server/` | API Node (Express) que recibe la telemetría y la muestra en un dashboard con login. Ver [`server/README.md`](server/README.md). |
| `.github/workflows/deploy.yml` | CI/CD: en push a `main`, pide a la deploy-api global que despliegue `server/` en la VM 103. |

## Arquitectura

```
ESP32-C5  ──(STA, 5GHz)──▶  RedRestringida  ──▶  internet
   │                                            │
   └──(AP "ESP32-Extender" + NAT)──▶ laptop/celular
   │
   └──HTTPS POST cada 30s──▶ esp32.angelonesto.com  (VM 103)  ──▶  dashboard
```

El firmware y el servidor son **dos cosas distintas**: el `.ino` corre en la placa;
`server/` corre en la VM. El token (`DEVICE_TOKEN`) tiene que ser el mismo en ambos.

## Despliegue

`server/` se despliega en la **VM 103** (app aparte, su propio PM2 y túnel) a través
de la **deploy-api global** (`deploy.angelonesto.com`), registrada como proyecto
`esp32-telemetry`. Un `git push` a `main` dispara el deploy. Detalles en
[`server/README.md`](server/README.md).

> **Repo privado:** el firmware incluye la clave WiFi de RedRestringida y el
> `DEVICE_TOKEN` compilados. Mantener el repositorio en privado.
