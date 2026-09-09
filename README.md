# WhatsApp Relay UTM

Servicio Node.js que conecta WhatsApp con el agente RAG de la UTM y expone una API para el panel web.

## Configuración

```bash
cp .env.example .env
npm install
npm run dev
```

Configure `FRONTEND_ORIGINS` con los orígenes permitidos, separados por comas. En producción no use `*`.

## API para el frontend

| Método | Ruta | Uso |
| --- | --- | --- |
| `GET` | `/health` | Salud del servicio y estado resumido de WhatsApp |
| `GET` | `/api/whatsapp/status` | Estado de conexión y disponibilidad del QR |
| `GET` | `/api/whatsapp/qr` | QR como data URL para mostrar en una imagen |
| `POST` | `/api/whatsapp/connect` | Inicia la conexión o generación del QR |
| `POST` | `/api/send-text` | Envía un mensaje |

El frontend debe consultar el estado periódicamente. Cuando `qrAvailable` sea `true`, puede obtener el QR y asignar `data.qr` al atributo `src` de una imagen.

```js
const API_URL = "http://localhost:5005";

await fetch(`${API_URL}/api/whatsapp/connect`, { method: "POST" });

const statusResponse = await fetch(`${API_URL}/api/whatsapp/status`);
const { data: status } = await statusResponse.json();

if (status.qrAvailable) {
  const qrResponse = await fetch(`${API_URL}/api/whatsapp/qr`);
  const { data } = await qrResponse.json();
  document.querySelector("#whatsapp-qr").src = data.qr;
}
```

Para enviar mensajes, `to` puede ser un número internacional o un identificador de WhatsApp:

```js
await fetch(`${API_URL}/api/send-text`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ to: "593999999999", body: "Hola" }),
});
```

Los archivos `.env`, `.sessions/` y `.node-persist/` son datos locales y no deben subirse al repositorio.
