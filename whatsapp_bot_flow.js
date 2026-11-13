/**
 * MOTOR DE AUTOMATIZACIÓN DE REMESAS CHAZQUIENVIOS
 * Conexión a APIs (CuantoEstaElDolar.pe + DolarApi.com)
 * Comisión fija del 4% y Generación de Tickets Oficiales ChazquiEnvios
 */

class RemesasBotEngine {
  constructor(configMercado) {
    this.empresa = "ChazquiEnvios";
    this.tiempo_validez_horas = 2;
    this.comision_porcentaje = 4.0; // 4% siempre
    this.contadorCotizacion = 107; // Correlativo N°: 00107, 00108...

    // Datos bancarios para transferir (según tickets oficiales)
    this.cuentas = {
      PERU: {
        tipo: "Cuenta para transferir:",
        numero: "948206358",
        titular: "Jesus Juarez",
        banco: "Yape"
      },
      ARGENTINA: {
        tipo: "Alias para transferir:",
        numero: "jesus.maia.bb",
        titular: "Jesus Juarez",
        banco: "Banco Ciudad"
      }
    };

    // Cotizaciones automáticas por defecto (según CuantoEstaElDolar.pe y DolarApi.com)
    this.mercado = configMercado || {
      // CuantoEstaElDolar.pe (Paralelo)
      peru_paralelo_compra: 3.400,
      peru_paralelo_venta: 3.420,

      // DolarApi.com (Promedios sin decimales)
      argentina_dolar_blue_promedio: 1560,    // Para Perú -> Argentina
      argentina_dolar_cripto_promedio: 1654,  // Para Argentina -> Perú

      margen_venta_peru_a_arg: 0.01,   // Venta + 0.01 (ej: 3.42 + 0.01 = 3.43)
      margen_compra_arg_a_peru: -0.01, // Compra - 0.01 (ej: 3.40 - 0.01 = 3.39)

      ultima_sincronizacion: new Date().toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" })
    };

    this.sessions = {};
    this.onHumanTakeover = null;
  }

  // Tasas aplicadas con los márgenes del usuario
  get cambioSolesPeruArg() {
    // Venta + 0.01
    return Math.round((this.mercado.peru_paralelo_venta + this.mercado.margen_venta_peru_a_arg) * 100) / 100;
  }

  get cambioSolesArgPeru() {
    // Compra - 0.01
    return Math.round((this.mercado.peru_paralelo_compra + this.mercado.margen_compra_arg_a_peru) * 100) / 100;
  }

  get cambioPesosPeruArg() {
    // Dólar Blue promedio sin decimales
    return Math.round(this.mercado.argentina_dolar_blue_promedio);
  }

  get cambioPesosArgPeru() {
    // Dólar Cripto promedio sin decimales
    return Math.round(this.mercado.argentina_dolar_cripto_promedio);
  }

  actualizarCotizaciones(nuevosDatos) {
    if (!nuevosDatos) return;
    if (nuevosDatos.peru_paralelo_compra) this.mercado.peru_paralelo_compra = parseFloat(nuevosDatos.peru_paralelo_compra);
    if (nuevosDatos.peru_paralelo_venta) this.mercado.peru_paralelo_venta = parseFloat(nuevosDatos.peru_paralelo_venta);
    if (nuevosDatos.argentina_dolar_blue_promedio) this.mercado.argentina_dolar_blue_promedio = Math.round(parseFloat(nuevosDatos.argentina_dolar_blue_promedio));
    if (nuevosDatos.argentina_dolar_cripto_promedio) this.mercado.argentina_dolar_cripto_promedio = Math.round(parseFloat(nuevosDatos.argentina_dolar_cripto_promedio));
    this.mercado.ultima_sincronizacion = new Date().toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });
  }

  getSession(phoneNumber) {
    if (!this.sessions[phoneNumber]) {
      this.sessions[phoneNumber] = {
        phoneNumber: phoneNumber,
        step: "INICIO",
        ruta: null,
        cotizacionActual: null,
        ultimaInteraccion: new Date()
      };
    }
    return this.sessions[phoneNumber];
  }

  resetSession(phoneNumber) {
    this.sessions[phoneNumber] = {
      phoneNumber: phoneNumber,
      step: "INICIO",
      ruta: null,
      cotizacionActual: null,
      ultimaInteraccion: new Date()
    };
  }

  // CÁLCULO EXACTO DE REMESA CON COMISIÓN DEL 4%
  calcularCotizacion(rutaKey, totalPagar) {
    const factorComision = 1 + (this.comision_porcentaje / 100); // 1.04
    const montoNeto = totalPagar / factorComision;
    const montoComision = totalPagar - montoNeto;

    let cambioSoles = 0;
    let cambioPesos = 0;
    let montoDolares = 0;
    let montoRecibir = 0;
    let cuentaTransferir = null;
    let paisDestino = "";
    let banderaDestino = "";
    let monedaPago = "";
    let monedaRecibir = "";

    const numCotizacion = String(this.contadorCotizacion++).padStart(5, "0");

    if (rutaKey === "ARGENTINA_A_PERU") {
      // Cliente paga en pesos argentinos -> Recibe soles peruanos
      paisDestino = "Perú";
      banderaDestino = "🇵🇪";
      monedaPago = "pesos";
      monedaRecibir = "soles";
      cuentaTransferir = this.cuentas.ARGENTINA;

      cambioPesos = this.cambioPesosArgPeru; // Dólar Cripto promedio sin decimales
      cambioSoles = this.cambioSolesArgPeru; // CuantoEstaElDolar Compra - 0.01

      // 1. Pesos netos a Dólares
      montoDolares = montoNeto / cambioPesos;
      // 2. Dólares a Soles
      montoRecibir = Math.round((montoDolares * cambioSoles) * 100) / 100;

    } else {
      // PERU_A_ARGENTINA
      // Cliente paga en soles peruanos -> Recibe pesos argentinos
      paisDestino = "Argentina";
      banderaDestino = "🇦🇷";
      monedaPago = "soles";
      monedaRecibir = "pesos";
      cuentaTransferir = this.cuentas.PERU;

      cambioSoles = this.cambioSolesPeruArg; // CuantoEstaElDolar Venta + 0.01
      cambioPesos = this.cambioPesosPeruArg; // Dólar Blue promedio sin decimales

      // 1. Soles netos a Dólares
      montoDolares = montoNeto / cambioSoles;
      // 2. Dólares a Pesos (sin decimales)
      montoRecibir = Math.round(montoDolares * cambioPesos);
    }

    const ahora = new Date();
    const fechaStr = ahora.toLocaleDateString("es-PE", { day: "2-digit", month: "2-digit", year: "numeric" });
    const horaStr = ahora.toLocaleTimeString("es-PE", { hour: "numeric", minute: "2-digit", hour12: true }).toLowerCase();

    return {
      numCotizacion,
      rutaKey,
      paisDestino,
      banderaDestino,
      monedaPago,
      monedaRecibir,
      totalPagar,
      montoNeto: Math.round(montoNeto * 100) / 100,
      montoComision: Math.round(montoComision * 100) / 100,
      cambioSoles,
      cambioPesos,
      montoDolares: Math.round(montoDolares * 100) / 100,
      montoRecibir,
      cuentaTransferir,
      fechaStr,
      horaStr,
      horasValidez: this.tiempo_validez_horas
    };
  }

  // GENERAR EL TICKET OFICIAL CHAZQUIENVIOS IDÉNTICO AL MODELO
  generarTicketTexto(cot) {
    const totalPagarFmt = cot.monedaPago === "pesos" 
      ? Math.round(cot.totalPagar).toLocaleString("es") 
      : (Number.isInteger(cot.totalPagar) ? cot.totalPagar : cot.totalPagar.toFixed(2));

    const comisionFmt = cot.monedaPago === "pesos" 
      ? Math.round(cot.montoComision).toLocaleString("es") 
      : cot.montoComision.toFixed(2);

    const recibirFmt = cot.monedaRecibir === "pesos" 
      ? Math.round(cot.montoRecibir).toLocaleString("es") 
      : cot.montoRecibir.toFixed(2);

    return (
`💸 *${this.empresa}*
Cotización N°: ${cot.numCotizacion} ✅
-----------------------
Envió a: ${cot.banderaDestino} ${cot.paisDestino}
Total a pagar: ${totalPagarFmt} ${cot.monedaPago} 💳
Monto a recibir: ${recibirFmt} ${cot.monedaRecibir} 😊
-----------------------
${cot.cuentaTransferir.tipo}
*${cot.cuentaTransferir.numero}*
Nombre: ${cot.cuentaTransferir.titular}
Banco: ${cot.cuentaTransferir.banco}
-----------------------
Cambio soles: ${cot.cambioSoles}
Cambio pesos: ${cot.cambioPesos.toLocaleString("es")}
Comisión: ${this.comision_porcentaje}% (${comisionFmt} ${cot.monedaPago})
👉 Enviar comprobante por aquí.
📌 Cotización valida por ${cot.horasValidez} horas.

Fecha: ${cot.fechaStr}   ${cot.horaStr}`
    );
  }

  triggerHumanTakeover(session) {
    session.step = "HUMAN_TAKEOVER";
    session.takeoverTimestamp = new Date();

    const cot = session.cotizacionActual;
    const alertData = {
      cliente: session.phoneNumber,
      cotizacionNum: cot ? cot.numCotizacion : "N/D",
      fechaHora: new Date().toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires" }),
      ruta: cot ? `Envió a ${cot.paisDestino}` : "N/D",
      totalPagar: cot ? `${cot.totalPagar.toLocaleString("es")} ${cot.monedaPago}` : "N/D",
      montoRecibir: cot ? `${cot.montoRecibir.toLocaleString("es")} ${cot.monedaRecibir}` : "N/D",
      comision: cot ? `${cot.montoComision.toLocaleString("es")} ${cot.monedaPago}` : "N/D",
      cuentaDestino: cot ? `${cot.cuentaTransferir.banco} (${cot.cuentaTransferir.numero})` : "N/D"
    };

    if (typeof this.onHumanTakeover === "function") {
      this.onHumanTakeover(alertData);
    }

    return alertData;
  }

  // DETECCIÓN RÁPIDA DE INTENCIÓN Y MONTO
  intentarParseoDirecto(texto) {
    const t = texto.toLowerCase();
    let ruta = null;

    if ((t.includes("peru") && t.includes("argentina")) || t.includes("soles a pesos") || t.includes("soles")) {
      if (t.includes("de argentina a peru") || t.includes("pesos a soles")) {
        ruta = "ARGENTINA_A_PERU";
      } else {
        ruta = "PERU_A_ARGENTINA";
      }
    } else if (t.includes("pesos") || t.includes("ars")) {
      ruta = "ARGENTINA_A_PERU";
    }

    const matchNumero = t.match(/\d+([.,]\d+)?/);
    const monto = matchNumero ? parseFloat(matchNumero[0].replace(",", ".")) : null;

    if (ruta && monto && monto > 0) {
      return { ruta, monto };
    }
    return null;
  }

  // PROCESADOR CONVERSACIONAL DE WHATSAPP
  procesarMensaje(phoneNumber, mensajeTexto) {
    const session = this.getSession(phoneNumber);
    const texto = (mensajeTexto || "").trim();
    const textoLower = texto.toLowerCase();

    // 1. Si está en modo Humano (Bot silenciado)
    if (session.step === "HUMAN_TAKEOVER") {
      if (textoLower === "#reiniciar" || textoLower === "#bot") {
        this.resetSession(phoneNumber);
        return {
          tipo: "BOT_TEXTO",
          respuesta: "🤖 Automatización reactivada. ¡Hola nuevamente! ¿Qué envío deseas cotizar hoy?",
          session
        };
      }
      return {
        tipo: "HUMAN_TAKEOVER_ACTIVO",
        respuesta: null,
        session
      };
    }

    // 2. Comandos de reinicio
    if (textoLower === "menu" || textoLower === "inicio" || textoLower === "reiniciar" || textoLower === "cancelar") {
      this.resetSession(phoneNumber);
      return this.responderMenuPrincipal(session);
    }

    switch (session.step) {
      case "INICIO": {
        const parseo = this.intentarParseoDirecto(texto);
        if (parseo) {
          session.ruta = parseo.ruta;
          return this.generarRespuestaCotizacion(session, parseo.monto);
        }
        session.step = "SELECCION_RUTA";
        return this.responderMenuPrincipal(session);
      }

      case "SELECCION_RUTA": {
        if (texto === "1" || textoLower.includes("peru a arg") || textoLower.includes("soles")) {
          session.ruta = "PERU_A_ARGENTINA";
          session.step = "ESPERANDO_MONTO";
          return {
            tipo: "BOT_TEXTO",
            respuesta: 
`🇵🇪 ➔ 🇦🇷 *Envío desde Perú hacia Argentina*
━━━━━━━━━━━━━━━━━━━━
📊 *Tasas en tiempo real:*
• Cambio Soles (Venta + 0.01): *${this.cambioSolesPeruArg}*
• Cambio Pesos (Dólar Blue): *${this.cambioPesosPeruArg.toLocaleString("es")}*
• Comisión de servicio: *4%*

💬 *Por favor escribe el monto en Soles (PEN) que deseas transferir:*
_(Ejemplo: 30 o 500)_`,
            session
          };
        } else if (texto === "2" || textoLower.includes("arg a peru") || textoLower.includes("pesos")) {
          session.ruta = "ARGENTINA_A_PERU";
          session.step = "ESPERANDO_MONTO";
          return {
            tipo: "BOT_TEXTO",
            respuesta: 
`🇦🇷 ➔ 🇵🇪 *Envío desde Argentina hacia Perú*
━━━━━━━━━━━━━━━━━━━━
📊 *Tasas en tiempo real:*
• Cambio Pesos (Dólar Cripto): *${this.cambioPesosArgPeru.toLocaleString("es")}*
• Cambio Soles (Compra - 0.01): *${this.cambioSolesArgPeru}*
• Comisión de servicio: *4%*

💬 *Por favor escribe el monto en Pesos (ARS) que deseas transferir:*
_(Ejemplo: 400000)_`,
            session
          };
        } else if (texto === "3" || textoLower.includes("asesor")) {
          this.triggerHumanTakeover(session);
          return {
            tipo: "TRANSFERENCIA_HUMANO",
            respuesta: `👨‍💼 *Conectando con un asesor humano...*\n\nHe notificado al equipo de ChazquiEnvios. Un asesor tomará este chat en breve para ayudarte.`,
            session
          };
        } else {
          return {
            tipo: "BOT_TEXTO",
            respuesta: `⚠️ Por favor responde con el número:\n\n1️⃣ Perú ➔ Argentina (Soles a Pesos)\n2️⃣ Argentina ➔ Perú (Pesos a Soles)\n3️⃣ Hablar con un asesor`,
            session
          };
        }
      }

      case "ESPERANDO_MONTO": {
        const montoLimpio = parseFloat(texto.replace(/[^0-9.,]/g, "").replace(",", "."));
        if (isNaN(montoLimpio) || montoLimpio <= 0) {
          return {
            tipo: "BOT_TEXTO",
            respuesta: `⚠️ No pude reconocer el número. Por favor ingresa solo la cifra numérica a cotizar (ej: 400000).`,
            session
          };
        }
        return this.generarRespuestaCotizacion(session, montoLimpio);
      }

      case "COTIZACION_ACTIVA": {
        const afirmativos = ["1", "si", "sí", "acepto", "dale", "proceder", "enviar", "transferir", "quiero", "pásame los datos", "pasame la cuenta", "ticket"];
        const esAfirmativo = afirmativos.some(palabra => textoLower === palabra || textoLower.startsWith(palabra));

        if (esAfirmativo) {
          // GENERAR TICKET OFICIAL Y DISPARAR HANDOVER HUMANO
          const ticketOficial = this.generarTicketTexto(session.cotizacionActual);
          const alertaOperador = this.triggerHumanTakeover(session);

          const mensajeSalida = 
`${ticketOficial}

━━━━━━━━━━━━━━━━━━━━
👨‍💼 *Un asesor humano de ChazquiEnvios ya está en este chat.*
_Por favor realiza la transferencia a la cuenta indicada arriba y envía tu comprobante aquí para que validemos la acreditación y realicemos el pago en destino de inmediato._`;

          return {
            tipo: "TICKET_GENERADO_HUMANO",
            alertaOperador,
            respuesta: mensajeSalida,
            session
          };
        } else if (texto === "2" || textoLower.includes("recotizar") || textoLower.includes("otro monto")) {
          session.step = "ESPERANDO_MONTO";
          return {
            tipo: "BOT_TEXTO",
            respuesta: `🔄 *Recotización:*\n\nPor favor escribe el nuevo monto a cotizar:`,
            session
          };
        } else if (texto === "3" || textoLower.includes("asesor")) {
          const alertaOperador = this.triggerHumanTakeover(session);
          return {
            tipo: "TRANSFERENCIA_HUMANO",
            alertaOperador,
            respuesta: `👨‍💼 *Derivando con un asesor humano...*\n\nUn operador responderá tus consultas directamente por este chat en segundos.`,
            session
          };
        } else {
          return {
            tipo: "BOT_TEXTO",
            respuesta: `💬 ¿Deseas hacer efectiva esta cotización y recibir tu ticket de pago?\n\n1️⃣ *SÍ, PROCEDER Y GENERAR TICKET* (te pasamos los datos para transferir)\n2️⃣ *RECOTIZAR OTRO MONTO*\n3️⃣ *HABLAR CON UN ASESOR*`,
            session
          };
        }
      }

      default:
        this.resetSession(phoneNumber);
        return this.responderMenuPrincipal(session);
    }
  }

  // Pre-cotización (Resumen antes de emitir el ticket formal con número)
  generarRespuestaCotizacion(session, monto) {
    const cot = this.calcularCotizacion(session.ruta, monto);
    session.cotizacionActual = cot;
    session.step = "COTIZACION_ACTIVA";

    const totalFmt = cot.monedaPago === "pesos" ? Math.round(cot.totalPagar).toLocaleString("es") : cot.totalPagar;
    const recibirFmt = cot.monedaRecibir === "pesos" ? Math.round(cot.montoRecibir).toLocaleString("es") : cot.montoRecibir.toFixed(2);
    const comisionFmt = cot.monedaPago === "pesos" ? Math.round(cot.montoComision).toLocaleString("es") : cot.montoComision.toFixed(2);

    const mensaje = 
`🧾 *COTIZACIÓN DE REMESA: ${this.empresa}*
━━━━━━━━━━━━━━━━━━━━
Envió a: ${cot.banderaDestino} *${cot.paisDestino}*

💵 Total a pagar: *${totalFmt} ${cot.monedaPago}*
💰 Monto a recibir: *${recibirFmt} ${cot.monedaRecibir}*
📊 Comisión: *${this.comision_porcentaje}%* (${comisionFmt} ${cot.monedaPago})

💱 Tasas aplicadas:
• Cambio soles: *${cot.cambioSoles}*
• Cambio pesos: *${cot.cambioPesos.toLocaleString("es")}*
📌 Cotización válida por *2 horas*.
━━━━━━━━━━━━━━━━━━━━
¿Deseas concretar el envío y recibir los datos de transferencia?

1️⃣ *SÍ, PROCEDER CON EL ENVÍO* (Generar ticket de pago)
2️⃣ *RECOTIZAR OTRO MONTO*
3️⃣ *HABLAR CON UN ASESOR*`;

    return {
      tipo: "COTIZACION_GENERADA",
      cotizacion: cot,
      respuesta: mensaje,
      session
    };
  }

  responderMenuPrincipal(session) {
    session.step = "SELECCION_RUTA";

    const mensaje = 
`👋 ¡Hola! Bienvenido a *${this.empresa}* 💸
Cotiza tu envío de dinero al instante con las mejores tasas:

¿Hacia dónde deseas enviar hoy?

1️⃣ 🇵🇪 ➔ 🇦🇷 *Perú a Argentina* (Pagas en Soles ➔ Reciben Pesos)
   _Cambio soles: ${this.cambioSolesPeruArg} | Cambio pesos: ${this.cambioPesosPeruArg.toLocaleString("es")}_

2️⃣ 🇦🇷 ➔ 🇵🇪 *Argentina a Perú* (Pagas en Pesos ➔ Reciben Soles)
   _Cambio pesos: ${this.cambioPesosArgPeru.toLocaleString("es")} | Cambio soles: ${this.cambioSolesArgPeru}_

3️⃣ 👨‍💼 *Hablar con un asesor humano*

_Responde con el número *1*, *2* o *3* para comenzar._`;

    return {
      tipo: "BOT_TEXTO",
      respuesta: mensaje,
      session
    };
  }
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = RemesasBotEngine;
}
if (typeof window !== "undefined") {
  window.RemesasBotEngine = RemesasBotEngine;
}
