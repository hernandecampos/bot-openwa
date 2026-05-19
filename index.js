require("dotenv").config();
const { create } = require("@open-wa/wa-automate");
const Anthropic = require("@anthropic-ai/sdk");
const express = require("express");
const qrcode = require("qrcode");

// ─── Servidor web para mostrar el QR ────────────────────────────────────────
const app = express();
let qrImageUrl = null;
let botConectado = false;

app.get("/", (req, res) => {
  if (botConectado) {
    return res.send(`
      <html>
        <head><meta charset="utf-8"><title>Bot Concesionaria</title></head>
        <body style="font-family:sans-serif;text-align:center;padding:40px;background:#f0f9f0">
          <h1 style="color:#25d366">✅ Bot conectado y funcionando</h1>
          <p style="font-size:18px">El bot de <strong>${process.env.NOMBRE_CONCESIONARIA || "la concesionaria"}</strong> está activo.</p>
          <p>Mensajes recibidos: <strong>${mensajesRecibidos}</strong></p>
          <p>Leads capturados: <strong>${leads.size}</strong></p>
          <br>
          <a href="/leads" style="background:#25d366;color:white;padding:10px 20px;border-radius:8px;text-decoration:none">Ver Leads</a>
        </body>
      </html>
    `);
  }

  if (qrImageUrl) {
    return res.send(`
      <html>
        <head>
          <meta charset="utf-8">
          <meta http-equiv="refresh" content="10">
          <title>Escanear QR - Bot Concesionaria</title>
        </head>
        <body style="font-family:sans-serif;text-align:center;padding:40px">
          <h1>📱 Escanear QR con WhatsApp</h1>
          <p>Abrí WhatsApp → Dispositivos vinculados → Vincular dispositivo → Escanear este QR</p>
          <img src="${qrImageUrl}" style="width:280px;height:280px;border:4px solid #25d366;border-radius:12px"/>
          <p style="color:#888;font-size:14px">Esta página se actualiza cada 10 segundos</p>
        </body>
      </html>
    `);
  }

  return res.send(`
    <html>
      <head>
        <meta charset="utf-8">
        <meta http-equiv="refresh" content="5">
        <title>Iniciando bot...</title>
      </head>
      <body style="font-family:sans-serif;text-align:center;padding:40px">
        <h1>⏳ Iniciando el bot...</h1>
        <p>Esperá unos segundos, el QR va a aparecer aquí.</p>
        <p style="color:#888">Esta página se actualiza sola.</p>
      </body>
    </html>
  `);
});

app.get("/leads", (req, res) => {
  const lista = Array.from(leads.values());
  res.json({ total: lista.length, leads: lista });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🌐 Servidor web corriendo en puerto ${PORT}`);
  console.log(`📱 Abrí la URL del servicio para escanear el QR`);
});

// ─── Almacenamiento en memoria ───────────────────────────────────────────────
const conversaciones = new Map(); // telefono -> [{role, content}]
const leads = new Map();          // telefono -> datos del lead
let mensajesRecibidos = 0;

function obtenerHistorial(telefono) {
  return conversaciones.get(telefono) || [];
}

function guardarMensaje(telefono, rol, mensaje) {
  if (!conversaciones.has(telefono)) {
    conversaciones.set(telefono, []);
  }
  const historial = conversaciones.get(telefono);
  historial.push({ role: rol, content: mensaje });
  if (historial.length > 20) historial.splice(0, historial.length - 20);
  conversaciones.set(telefono, historial);

  if (!leads.has(telefono)) {
    leads.set(telefono, {
      telefono,
      nombre: null,
      interes: null,
      estado: "nuevo",
      fecha_creacion: new Date().toLocaleString("es-AR"),
      ultima_interaccion: new Date().toLocaleString("es-AR"),
    });
  } else {
    leads.get(telefono).ultima_interaccion = new Date().toLocaleString("es-AR");
  }
}

// ─── Cliente de Claude ───────────────────────────────────────────────────────
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `Sos el asistente virtual de ${process.env.NOMBRE_CONCESIONARIA || "la concesionaria"}, especializado en la venta de vehículos nuevos y usados.

Tu objetivo principal es:
1. Responder consultas sobre vehículos disponibles (nuevos y usados)
2. Generar interés genuino en el prospecto
3. Conseguir que el prospecto agende una visita al salón de ventas

Información de la concesionaria:
- Nombre: ${process.env.NOMBRE_CONCESIONARIA || "la concesionaria"}
- Dirección: ${process.env.DIRECCION || "consultar por este medio"}
- Horario de atención: ${process.env.HORARIO || "Lunes a Sábado de 9 a 19hs"}
- Teléfono: ${process.env.TELEFONO_SALON || "consultar por este medio"}

Pautas de comportamiento:
- Respondé siempre en español, de forma cálida y profesional
- Mensajes cortos y directos, como en WhatsApp
- Cuando el cliente pregunte por un auto, pedí detalles: ¿nuevo o usado? ¿presupuesto? ¿financiación?
- Si muestra interés, invitalo a visitar el salón de forma natural
- Cuando confirme la visita, pedile: nombre completo, día y hora preferida
- Nunca inventes precios exactos ni stock específico
- Si el cliente da su nombre, usalo en la conversación
- Máximo 3 oraciones por mensaje

Señales para invitar al salón:
- Pregunta por precio de un modelo específico
- Pregunta por disponibilidad o colores
- Menciona que está pensando en cambiar el auto
- Pregunta por financiación

Cuando el cliente confirme la visita, usá este formato:
CITA_CONFIRMADA|nombre:[nombre]|dia:[dia]|hora:[hora]|interes:[modelo]`;

async function responderConClaude(telefono, mensajeUsuario) {
  guardarMensaje(telefono, "user", mensajeUsuario);
  const historial = obtenerHistorial(telefono);

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 500,
    system: SYSTEM_PROMPT,
    messages: historial,
  });

  let respuesta = response.content[0].text;

  // Procesar si hay cita confirmada
  if (respuesta.includes("CITA_CONFIRMADA|")) {
    const partes = {};
    respuesta.split("|").slice(1).forEach((p) => {
      const [clave, valor] = p.split(":");
      partes[clave] = valor;
    });

    const lead = leads.get(telefono);
    if (lead) {
      lead.nombre = partes.nombre || lead.nombre;
      lead.interes = partes.interes || lead.interes;
      lead.estado = "cita_agendada";
    }

    respuesta =
      `¡Perfecto ${partes.nombre || ""}! Tu visita quedó agendada para el ` +
      `*${partes.dia || "día acordado"}* a las *${partes.hora || "hora acordada"}*.\n\n` +
      `Te esperamos en *${process.env.NOMBRE_CONCESIONARIA}*\n` +
      `📍 ${process.env.DIRECCION}\n` +
      `¡Hasta pronto! 👋`;
  }

  guardarMensaje(telefono, "assistant", respuesta);
  return respuesta;
}

// ─── Configuración e inicio del bot ─────────────────────────────────────────
create({
  sessionId: "bot-concesionaria",
  authTimeout: 60,
  blockCrashLogs: true,
  disableSpins: true,
  headless: true,
  logConsole: false,
  popup: false,
  qrTimeout: 0,
  restartOnCrash: true,
  cacheEnabled: false,
  useChrome: false,
  killProcessOnBrowserClose: true,
  throwErrorOnTosBlock: false,
  chromiumArgs: [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-accelerated-2d-canvas",
    "--no-first-run",
    "--no-zygote",
    "--single-process",
    "--disable-gpu",
  ],
  onQr: async (qr) => {
    console.log("📱 QR generado — abrí la URL del servicio para escanearlo");
    try {
      qrImageUrl = await qrcode.toDataURL(qr);
    } catch (e) {
      console.error("Error generando imagen QR:", e.message);
    }
  },
}).then(async (client) => {
  botConectado = true;
  qrImageUrl = null;
  console.log("✅ Bot conectado a WhatsApp correctamente");

  client.onMessage(async (message) => {
    // Ignorar mensajes de grupos, estados y del propio bot
    if (
      message.isGroupMsg ||
      message.type === "status" ||
      message.type !== "chat" ||
      message.fromMe
    ) return;

    const telefono = message.from;
    const texto = message.body;
    mensajesRecibidos++;

    console.log(`📩 Mensaje de ${telefono}: ${texto}`);

    try {
      // Indicador de escritura
      await client.simulateTyping(telefono, true);

      const respuesta = await responderConClaude(telefono, texto);

      await client.simulateTyping(telefono, false);
      await client.sendText(telefono, respuesta);

      console.log(`✅ Respuesta enviada a ${telefono}`);
    } catch (error) {
      console.error("Error respondiendo:", error.message);
      await client.simulateTyping(telefono, false);
    }
  });

  console.log("🚗 Bot escuchando mensajes...");
});
