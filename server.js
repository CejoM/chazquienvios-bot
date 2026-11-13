require('dotenv').config();
process.env.TZ = process.env.TIMEZONE || 'America/Argentina/Buenos_Aires';
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const RemesasBotEngine = require('./whatsapp_bot_flow');
const ratesService = require('./services/rates_service');

const app = express();
const PORT = process.env.PORT || 3000;

// Configuración de Evolution API
const EVOLUTION_API_URL = (process.env.EVOLUTION_API_URL || '').replace(/\/$/, '');
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || '';
const INSTANCE_NAME = process.env.INSTANCE_NAME || 'ChazquiEnvios';
const OPERADOR_WHATSAPP = process.env.OPERADOR_WHATSAPP || '';

// LISTA BLANCA (MODO PRUEBAS): 
// Si está en "*", vacía o desactivada, responde a cualquiera que escriba.
const WHITELIST_RAW = process.env.WHITELIST_NUMEROS || '*';
const WHITELIST_NUMEROS = (WHITELIST_RAW === '*' || !WHITELIST_RAW) 
  ? [] 
  : WHITELIST_RAW.split(',').map(n => n.replace(/[^0-9]/g, '')).filter(Boolean);

// Buffer de logs recientes en memoria para diagnóstico
const ultimosLogs = [];
function registrarLog(tipo, msg) {
  const item = { hora: new Date().toLocaleTimeString(), tipo, msg };
  ultimosLogs.unshift(item);
  if (ultimosLogs.length > 30) ultimosLogs.pop();
  console.log(`[${item.hora}] [${tipo}] ${msg}`);
}

// Inicializar el motor del bot
const botEngine = new RemesasBotEngine();

// Iniciar sincronizador automático de tasas cada 5 minutos
ratesService.startAutoSync(botEngine);

// Handover callback: cuando un cliente genera un ticket
botEngine.onHumanTakeover = async (alertData) => {
  console.log('🚨 [HANDOVER HUMANO ACTIVADO]:', alertData);

  // Si se configuró un WhatsApp de operador, enviarle una alerta privada
  if (OPERADOR_WHATSAPP && EVOLUTION_API_URL && EVOLUTION_API_KEY) {
    const alertaOperadorMsg = 
`🚨 *NUEVO TICKET EMITIDO - ESPERANDO COMPROBANTE*
━━━━━━━━━━━━━━━━━━━━
🎟️ *Ticket N°:* ${alertData.cotizacionNum}
📱 *Cliente:* ${alertData.cliente}
🔄 *Operación:* ${alertData.ruta}
💵 *Total a pagar:* ${alertData.totalPagar}
💰 *Monto a recibir:* ${alertData.montoRecibir}
🏦 *Transferir a:* ${alertData.cuentaDestino}
📊 *Comisión 4%:* ${alertData.comision}
⏰ *Hora:* ${alertData.fechaHora}

👉 *Por favor revisa el chat de WhatsApp con el cliente y confirma la recepción del comprobante bancario.*`;

    try {
      await enviarMensajeWhatsApp(OPERADOR_WHATSAPP, alertaOperadorMsg);
      console.log(`✅ [Operador] Alerta enviada al teléfono ${OPERADOR_WHATSAPP}`);
    } catch (e) {
      console.error('⚠️ [Operador] No se pudo enviar alerta al operador:', e.message);
    }
  }
};

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

/**
 * Función para enviar mensaje de texto vía Evolution API
 */
async function enviarMensajeWhatsApp(telefono, texto) {
  if (!EVOLUTION_API_URL || !EVOLUTION_API_KEY) {
    console.warn('⚠️ [Evolution API] Falta configurar EVOLUTION_API_URL o EVOLUTION_API_KEY en variables de entorno.');
    return null;
  }

  // Limpiar el número de teléfono (quitar @s.whatsapp.net si viene incluido)
  const cleanNumber = String(telefono).replace('@s.whatsapp.net', '').replace(/[^0-9]/g, '');
  const url = `${EVOLUTION_API_URL}/message/sendText/${INSTANCE_NAME}`;

  try {
    const response = await axios.post(url, {
      number: cleanNumber,
      text: texto,
      options: {
        delay: 1000,
        presence: 'composing',
        linkPreview: false
      }
    }, {
      headers: {
        'apikey': EVOLUTION_API_KEY,
        'Content-Type': 'application/json'
      },
      timeout: 15000
    });

    return response.data;
  } catch (err) {
    console.error(`❌ [Error Evolution API] Enviando mensaje a ${cleanNumber}:`, err.response?.data || err.message);
    throw err;
  }
}

/**
 * WEBHOOK PRINCIPAL DE EVOLUTION API
 * Recibe eventos de mensajes entrantes desde WhatsApp
 */
app.post('/webhook', async (req, res) => {
  // Responder inmediatamente con 200 OK a Evolution API para evitar reintentos
  res.status(200).json({ status: 'received' });

  try {
    const body = req.body;
    const event = body.event;

    // Solo procesar mensajes entrantes (MESSAGES_UPSERT)
    if (event !== 'messages.upsert') {
      return;
    }

    const data = body.data;
    if (!data || !data.key) return;

    const remoteJid = data.key.remoteJid || '';
    if (remoteJid.includes('@g.us')) return; // Ignorar grupos

    // Limpieza robusta del número de teléfono (remueve sufijos :12 y @s.whatsapp.net)
    const phoneNumber = remoteJid.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');

    // Extraer texto del mensaje
    const message = data.message;
    if (!message) return;

    let mensajeTexto = '';
    if (message.conversation) {
      mensajeTexto = message.conversation;
    } else if (message.extendedTextMessage && message.extendedTextMessage.text) {
      mensajeTexto = message.extendedTextMessage.text;
    } else if (message.buttonsResponseMessage && message.buttonsResponseMessage.selectedDisplayText) {
      mensajeTexto = message.buttonsResponseMessage.selectedDisplayText;
    } else if (message.templateButtonReplyMessage && message.templateButtonReplyMessage.selectedDisplayText) {
      mensajeTexto = message.templateButtonReplyMessage.selectedDisplayText;
    }

    if (!mensajeTexto || typeof mensajeTexto !== 'string') return;

    // Si el mensaje fue enviado por el propio número (fromMe: true),
    // ignorarlo para no crear bucle, SALVO que sea un chat consigo mismo para pruebas.
    if (data.key.fromMe) {
      registrarLog('FROM_ME', `Mensaje propio en chat con ${phoneNumber}: "${mensajeTexto}" (ignorado para evitar bucles)`);
      return;
    }

    registrarLog('ENTRANTE', `Mensaje de +${phoneNumber}: "${mensajeTexto}"`);

    // FILTRO DE LISTA BLANCA (MODO PRUEBAS)
    if (WHITELIST_NUMEROS.length > 0) {
      const estaAutorizado = WHITELIST_NUMEROS.some(autorizado => {
        return phoneNumber === autorizado || phoneNumber.endsWith(autorizado.slice(-9));
      });

      if (!estaAutorizado) {
        registrarLog('WHITELIST_BLOQUEO', `Cliente +${phoneNumber} ignorado (no está en whitelist)`);
        return;
      }
    }

    // Procesar con el motor conversacional de ChazquiEnvios
    const resultado = botEngine.procesarMensaje(phoneNumber, mensajeTexto);

    if (resultado && resultado.respuesta) {
      registrarLog('BOT_RESPUESTA', `Enviando a +${phoneNumber}: ${resultado.tipo}`);
      await enviarMensajeWhatsApp(phoneNumber, resultado.respuesta);
    } else if (resultado && resultado.tipo === 'HUMAN_TAKEOVER_ACTIVO') {
      registrarLog('HUMAN_SILENCIO', `+${phoneNumber} en manos de operador.`);
    }

  } catch (err) {
    console.error('❌ [Error en Webhook]:', err);
  }
});

/**
 * Endpoints de Salud y Estado
 */
app.get('/api/logs', (req, res) => {
  res.json({
    total: ultimosLogs.length,
    logs: ultimosLogs
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    app: 'ChazquiEnvios Bot',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

app.get('/api/rates', (req, res) => {
  res.json({
    tasas: ratesService.getRates(),
    calculadas: {
      cambioSolesPeruArg: botEngine.cambioSolesPeruArg,
      cambioPesosPeruArg: botEngine.cambioPesosPeruArg,
      cambioPesosArgPeru: botEngine.cambioPesosArgPeru,
      cambioSolesArgPeru: botEngine.cambioSolesArgPeru,
      comision_porcentaje: botEngine.comision_porcentaje
    }
  });
});

app.post('/api/sync-rates', async (req, res) => {
  const updated = await ratesService.syncAll();
  botEngine.actualizarCotizaciones(updated);
  res.json({ success: true, rates: updated });
});

/**
 * Página Principal / Dashboard de Monitoreo en Railway
 */
app.get('/', (req, res) => {
  const rates = ratesService.getRates();
  const html = `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <title>ChazquiEnvios | Bot Backend Activo en Railway</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-slate-950 text-slate-100 min-h-screen flex items-center justify-center p-4">
  <div class="max-w-xl w-full bg-slate-900 border border-slate-800 rounded-3xl p-6 md:p-8 shadow-2xl space-y-6">
    <div class="flex items-center gap-3">
      <div class="w-12 h-12 rounded-2xl bg-emerald-600 flex items-center justify-center text-2xl shadow-lg">
        💸
      </div>
      <div>
        <h1 class="text-xl font-bold text-white flex items-center gap-2">
          ChazquiEnvios Bot
          <span class="text-xs px-2.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 font-semibold border border-emerald-500/30">ONLINE</span>
        </h1>
        <p class="text-xs text-slate-400">Servidor Node.js activo en Railway</p>
      </div>
    </div>

    <!-- Info de conexión -->
    <div class="bg-slate-950 border border-slate-800 rounded-2xl p-4 space-y-2 text-xs">
      <div class="flex justify-between">
        <span class="text-slate-400">Webhook URL para Evolution API:</span>
        <span class="font-mono text-emerald-400 font-bold">/webhook</span>
      </div>
      <div class="flex justify-between">
        <span class="text-slate-400">Evolution API Configurada:</span>
        <span class="font-mono ${EVOLUTION_API_URL ? 'text-emerald-400' : 'text-amber-400'}">
          ${EVOLUTION_API_URL ? 'Conectada (' + INSTANCE_NAME + ')' : 'Pendiente .env'}
        </span>
      </div>
      <div class="flex justify-between">
        <span class="text-slate-400">Modo Pruebas (Lista Blanca):</span>
        <span class="font-mono text-emerald-400 font-bold">
          ${WHITELIST_NUMEROS.length > 0 ? 'Activo (+' + WHITELIST_NUMEROS.join(', +') + ')' : 'Desactivado (Responde a todos)'}
        </span>
      </div>
      <div class="flex justify-between">
        <span class="text-slate-400">Notificaciones a Operador:</span>
        <span class="font-mono ${OPERADOR_WHATSAPP ? 'text-emerald-400' : 'text-slate-500'}">
          ${OPERADOR_WHATSAPP || 'No configurado'}
        </span>
      </div>
    </div>

    <!-- Cotizaciones activas -->
    <div class="bg-slate-950 border border-slate-800 rounded-2xl p-4 space-y-3 text-xs">
      <div class="flex justify-between items-center border-b border-slate-800 pb-2">
        <span class="font-bold text-slate-200 uppercase tracking-wider text-[11px]">Tasas en Tiempo Real</span>
        <span class="text-[10px] text-slate-400 font-mono">Actualizado: ${new Date(rates.ultima_sincronizacion).toLocaleTimeString()}</span>
      </div>
      <div class="grid grid-cols-2 gap-2 text-center font-mono">
        <div class="bg-slate-900 p-2 rounded-xl border border-slate-800">
          <span class="text-[10px] text-slate-400 block">🇵🇪 Paralelo Venta (+0.01)</span>
          <span class="text-sm font-bold text-emerald-400">${botEngine.cambioSolesPeruArg}</span>
        </div>
        <div class="bg-slate-900 p-2 rounded-xl border border-slate-800">
          <span class="text-[10px] text-slate-400 block">🇦🇷 Dólar Blue Promedio</span>
          <span class="text-sm font-bold text-emerald-400">$ ${botEngine.cambioPesosPeruArg}</span>
        </div>
        <div class="bg-slate-900 p-2 rounded-xl border border-slate-800">
          <span class="text-[10px] text-slate-400 block">🇦🇷 Dólar Cripto Promedio</span>
          <span class="text-sm font-bold text-amber-400">$ ${botEngine.cambioPesosArgPeru}</span>
        </div>
        <div class="bg-slate-900 p-2 rounded-xl border border-slate-800">
          <span class="text-[10px] text-slate-400 block">🇵🇪 Paralelo Compra (-0.01)</span>
          <span class="text-sm font-bold text-amber-400">${botEngine.cambioSolesArgPeru}</span>
        </div>
      </div>
      <div class="text-[11px] text-center text-slate-400 pt-1">
        Comisión de servicio: <b>${botEngine.comision_porcentaje}%</b> • Validez: <b>${botEngine.tiempo_validez_horas} horas</b>
      </div>
    </div>

    <div class="text-center text-xs text-slate-500">
      ChazquiEnvios © 2026 • Motor Conversacional Automatizado
    </div>
  </div>
</body>
</html>
  `;
  res.send(html);
});

app.listen(PORT, () => {
  console.log(`🚀 [ChazquiEnvios Bot] Servidor escuchando en el puerto ${PORT}`);
  console.log(`🔗 Webhook URL: http://localhost:${PORT}/webhook`);
});
