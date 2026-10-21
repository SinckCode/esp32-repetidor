# ESP32-C5 Telemetry — API + Dashboard

App mínima (Node + Express, **sin dependencias nativas**) que recibe la telemetría
del repetidor ESP32-C5, la guarda y la muestra en un dashboard protegido con login.
Pensada para correr en cualquier VM, detrás de un túnel HTTPS (p. ej. Cloudflare).

## Qué hace

- `POST /api/telemetry` — el ESP32 manda JSON con `Authorization: Bearer <DEVICE_TOKEN>`.
  Cada muestra se guarda como una línea en `data/telemetry.jsonl`.
- `GET /` — dashboard en vivo (requiere login). Muestra: STA conectado, **MAC clonada**
  (resaltada si coincide con la esperada), IP en la red destino, **NAPT OK/FALLO**, RSSI,
  canal, clientes en el AP, uptime, heap libre, gráfico de RSSI e historial.
- `GET /login` · `POST /login` · `POST /logout` — sesión con un solo usuario.
- `GET /health` — para healthchecks (sin auth).

## Variables (`.env`)

Copia `.env.example` a `.env` y rellena:

| Variable | Qué es |
|---|---|
| `PORT` | puerto local detrás del túnel (ej. `5055`) |
| `DEVICE_TOKEN` | token del ESP32. **Debe ser idéntico** al `DEVICE_TOKEN` del sketch |
| `DASH_USER` / `DASH_PASS` | credenciales del dashboard (solo tú) |
| `SESSION_SECRET` | cadena larga aleatoria para firmar la cookie |
| `COOKIE_SECURE` | `true` en producción (HTTPS); `false` solo para probar en `http://localhost` |
| `EXPECTED_MAC` | opcional; MAC que se resalta como "correcta" (def. `00:11:22:33:44:55`) |

Genera secretos fuertes:
```bash
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

## Probar en local

```bash
cp .env.example .env     # pon COOKIE_SECURE=false para http://localhost
npm install
npm start
# abre http://localhost:5055  (login con DASH_USER/DASH_PASS)
```

## Desplegar en una VM (PM2 + túnel HTTPS)

1. **Copiar el código** a tu VM, en su **propia carpeta** (proceso PM2, puerto y
   `.env` independientes):
   ```bash
   # dentro de la VM
   mkdir -p ~/Apis/esp32-telemetry && cd ~/Apis/esp32-telemetry
   # sube el contenido de esta carpeta server/ (git clone o scp)
   npm ci --omit=dev
   cp .env.example .env && nano .env     # token, usuario, clave, secreto; COOKIE_SECURE=true
   ```

2. **Arrancar con PM2** y dejarlo persistente:
   ```bash
   pm2 start server.js --name esp32-telemetry
   pm2 save
   ```

3. **Exponerlo por Cloudflare** (como tus otros túneles). En la config del
   `cloudflared` de esa VM añade una regla de ingress y su DNS:
   ```yaml
   # ~/.cloudflared/config.yml  (o donde tengas el tunnel)
   ingress:
     - hostname: tu-servidor.ejemplo.com
       service: http://localhost:5055
     # ...tus otras reglas...
     - service: http_status:404
   ```
   ```bash
   cloudflared tunnel route dns <nombre-del-tunnel> tu-servidor.ejemplo.com
   # reinicia el servicio cloudflared
   ```

4. **Apuntar el ESP32**: en `WifiESP32Mac.ino` pon
   `SERVER_URL = "https://tu-servidor.ejemplo.com/api/telemetry"` y el mismo
   `DEVICE_TOKEN` que en el `.env`. Sube el sketch.

5. Abre `https://tu-servidor.ejemplo.com`, entra con tu usuario/clave y mira la
   telemetría llegar cada 30 s.

## Notas

- **Sin build nativo:** solo `express` y `express-session`, así que `npm ci`
  funciona en cualquier VM sin `build-essential`.
- **Falla cerrada:** si falta `DEVICE_TOKEN`, `/api/telemetry` responde `503`
  (no acepta datos anónimos). Si falta `DASH_PASS`, nadie puede entrar al panel.
- **Datos:** se guardan en `data/telemetry.jsonl` (una línea JSON por muestra).
  A 30 s/muestra ≈ 1 MB/día. Si corre meses, rota el archivo (logrotate o borrarlo).
- **TLS del ESP32:** el sketch usa `client.setInsecure()` (no valida el cert del
  túnel). Es aceptable para una práctica; para endurecerlo se puede fijar el CA raíz
  de Cloudflare en el firmware.
