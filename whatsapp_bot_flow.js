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

      // DolarApi.com
      argentina_dolar_blue_promedio: 1560,    // Para Perú -> Argentina (Promedio sin decimales)
      argentina_dolar_cripto_compra: 1666,    // Para Argentina -> Perú (Dólar Cripto COMPRA sin decimales)
      argentina_dolar_cripto_promedio: 1666,

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
    // Para Argentina -> Perú: Dólar Cripto COMPRA sin decimales
    return Math.round(this.mercado.argentina_dolar_cripto_compra || this.mercado.argentina_dolar_cripto_promedio);
  }

  actualizarCotizaciones(nuevosDatos) {
    if (!nuevosDatos) return;
    if (nuevosDatos.peru_paralelo_compra) this.mercado.peru_paralelo_compra = parseFloat(nuevosDatos.peru_paralelo_compra);
    if (nuevosDatos.peru_paralelo_venta) this.mercado.peru_paralelo_venta = parseFloat(nuevosDatos.peru_paralelo_venta);
    if (nuevosDatos.argentina_dolar_blue_promedio) this.mercado.argentina_dolar_blue_promedio = Math.round(parseFloat(nuevosDatos.argentina_dolar_blue_promedio));
    if (nuevosDatos.argentina_dolar_cripto_compra) this.mercado.argentina_dolar_cripto_compra = Math.round(parseFloat(nuevosDatos.argentina_dolar_cripto_compra));
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
  // tipo: "ENVIAR" (monto a pagar) o "RECIBIR" (monto neto a recibir en destino)
  calcularCotizacion(rutaKey, monto, tipo = "ENVIAR") {
    let totalPagar = 0;
    let montoNeto = 0;
    let montoComision = 0;
    let montoDolares = 0;
    let montoRecibir = 0;

    const factorComision = 1 + (this.comision_porcentaje / 100); // 1.04

    let cambioSoles = 0;
    let cambioPesos = 0;
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

      if (tipo === "RECIBIR") {
        // El cliente especificó cuánto quiere que LLEGUE en Soles (ej: 96 soles)
        montoRecibir = Math.round(monto * 100) / 100;
        // 1. Dólares necesarios
        montoDolares = montoRecibir / cambioSoles;
        // 2. Pesos netos requeridos
        montoNeto = montoDolares * cambioPesos;
        // 3. Total a pagar con comisión del 4% incluida
        totalPagar = Math.round(montoNeto * factorComision);
        montoComision = totalPagar - Math.round(montoNeto);
      } else {
        // El cliente especificó cuánto va a PAGAR en Pesos (ej: 400.000 pesos)
        totalPagar = Math.round(monto);
        montoNeto = totalPagar / factorComision;
        montoComision = totalPagar - montoNeto;
        montoDolares = montoNeto / cambioPesos;
        montoRecibir = Math.round((montoDolares * cambioSoles) * 100) / 100;
      }

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

      if (tipo === "RECIBIR") {
        // El cliente especificó cuánto quiere que LLEGUE en Pesos (ej: 45000 pesos)
        montoRecibir = Math.round(monto);
        // 1. Dólares necesarios
        montoDolares = montoRecibir / cambioPesos;
        // 2. Soles netos requeridos
        montoNeto = montoDolares * cambioSoles;
        // 3. Total a pagar en Soles con comisión del 4%
        totalPagar = Math.round((montoNeto * factorComision) * 100) / 100;
        montoComision = Math.round((totalPagar - montoNeto) * 100) / 100;
      } else {
        // El cliente especificó cuánto va a PAGAR en Soles (ej: 30 soles)
        totalPagar = monto;
        montoNeto = totalPagar / factorComision;
        montoComision = totalPagar - montoNeto;
        montoDolares = montoNeto / cambioSoles;
        montoRecibir = Math.round(montoDolares * cambioPesos);
      }
    }

    // Hora exacta del sistema en ese momento (zona horaria configurable, por defecto Perú/Argentina)
    const timeZone = process.env.TIMEZONE || (rutaKey === "ARGENTINA_A_PERU" ? "America/Argentina/Buenos_Aires" : "America/Lima");
    const ahora = new Date();
    const fechaStr = ahora.toLocaleDateString("es-PE", { day: "2-digit", month: "2-digit", year: "numeric", timeZone });
    const horaStr = ahora.toLocaleTimeString("es-PE", { hour: "numeric", minute: "2-digit", hour12: true, timeZone }).toLowerCase();

    return {
      numCotizacion,
      rutaKey,
      tipoCotizacion: tipo,
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

    // Hora de sistema en el momento exacto de emisión
    const timeZone = process.env.TIMEZONE || (cot.rutaKey === "ARGENTINA_A_PERU" ? "America/Argentina/Buenos_Aires" : "America/Lima");
    const ahora = new Date();
    const fechaActual = ahora.toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit", year: "numeric", timeZone });
    const horaActual = ahora.toLocaleTimeString("es-AR", { hour: "numeric", minute: "2-digit", hour12: true, timeZone }).toLowerCase();

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

Fecha: ${fechaActual}   ${horaActual}`
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

  // DETECTAR INTELIGENTEMENTE SI EL MONTO ES PARA ENVIAR O PARA RECIBIR
  analizarMontoYTipo(texto, rutaKey) {
    const t = (texto || "").toLowerCase();

    // Extraer número
    const matchNumero = t.match(/\d+([.,]\d+)?/);
    if (!matchNumero) return null;
    const monto = parseFloat(matchNumero[0].replace(",", "."));
    if (isNaN(monto) || monto <= 0) return null;

    let tipo = "ENVIAR";

    const mencionaSoles = t.includes("sol") || t.includes("soles") || t.includes("pen") || t.includes("s/");
    const mencionaPesos = t.includes("peso") || t.includes("pesos") || t.includes("ars");
    const mencionaRecibir = t.includes("recib") || t.includes("llegue") || t.includes("llegar") || t.includes("cobrar");
    const mencionaEnviar = t.includes("enviar") || t.includes("mandar") || t.includes("pagar") || t.includes("transferir");

    if (rutaKey === "ARGENTINA_A_PERU") {
      // Origen = Pesos (enviar) | Destino = Soles (recibir)
      if (mencionaSoles || mencionaRecibir) {
        tipo = "RECIBIR";
      } else if (mencionaPesos || mencionaEnviar) {
        tipo = "ENVIAR";
      } else {
        // Si escribe un número pequeño (ej: 96, 100, 250), son Soles a recibir
        // Si escribe un número grande (ej: 45000, 400000), son Pesos a enviar
        tipo = monto < 2500 ? "RECIBIR" : "ENVIAR";
      }
    } else {
      // PERU_A_ARGENTINA
      // Origen = Soles (enviar) | Destino = Pesos (recibir)
      if (mencionaPesos || mencionaRecibir) {
        tipo = "RECIBIR";
      } else if (mencionaSoles || mencionaEnviar) {
        tipo = "ENVIAR";
      } else {
        // Si escribe un número grande (ej: 45000), son Pesos a recibir
        // Si escribe un número pequeño (ej: 30, 50, 200), son Soles a enviar
        tipo = monto >= 2500 ? "RECIBIR" : "ENVIAR";
      }
    }

    return { monto, tipo };
  }

  // DETECCIÓN RÁPIDA DE INTENCIÓN Y MONTO AL INICIO
  intentarParseoDirecto(texto) {
    const t = texto.toLowerCase();
    let ruta = null;

    if (t.includes("arg") || t.includes("argentina a peru") || t.includes("pesos a soles")) {
      ruta = "ARGENTINA_A_PERU";
    } else if (t.includes("peru") || t.includes("peru a arg") || t.includes("soles a pesos")) {
      ruta = "PERU_A_ARGENTINA";
    }

    if (ruta) {
      const parsed = this.analizarMontoYTipo(texto, ruta);
      if (parsed) {
        return { ruta, monto: parsed.monto, tipo: parsed.tipo };
      }
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
          return this.generarRespuestaCotizacion(session, parseo.monto, parseo.tipo);
        }
        session.step = "SELECCION_RUTA";
        return this.responderMenuPrincipal(session);
      }

      case "SELECCION_RUTA": {
        if (texto === "1" || textoLower.includes("arg a peru") || textoLower.includes("pesos")) {
          session.ruta = "ARGENTINA_A_PERU";
          session.step = "ESPERANDO_MONTO";
          return {
            tipo: "BOT_TEXTO",
            respuesta: 
`🇦🇷 ➔ 🇵🇪 *Envío desde Argentina hacia Perú*

💬 *Por favor escribe el monto que quieres enviar o recibir:*
_(Ejemplo: 45000 pesos o 96 soles)_`,
            session
          };
        } else if (texto === "2" || textoLower.includes("peru a arg") || textoLower.includes("soles")) {
          session.ruta = "PERU_A_ARGENTINA";
          session.step = "ESPERANDO_MONTO";
          return {
            tipo: "BOT_TEXTO",
            respuesta: 
`🇵🇪 ➔ 🇦🇷 *Envío desde Perú hacia Argentina*

💬 *Por favor escribe el monto que quieres enviar o recibir:*
_(Ejemplo: 30 soles o 45000 pesos)_`,
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
            respuesta: `⚠️ Por favor responde con el número:\n\n1️⃣ Argentina ➔ Perú (Pesos a Soles)\n2️⃣ Perú ➔ Argentina (Soles a Pesos)\n3️⃣ Hablar con un asesor`,
            session
          };
        }
      }

      case "ESPERANDO_MONTO": {
        const parsed = this.analizarMontoYTipo(texto, session.ruta);
        if (!parsed || parsed.monto <= 0) {
          return {
            tipo: "BOT_TEXTO",
            respuesta: `⚠️ No pude reconocer el monto. Por favor escribe la cantidad que deseas enviar o recibir (ejemplo: 45000 pesos o 96 soles).`,
            session
          };
        }
        return this.generarRespuestaCotizacion(session, parsed.monto, parsed.tipo);
      }

      case "COTIZACION_ACTIVA": {
        const afirmativos = ["1", "si", "sí", "acepto", "dale", "proceder", "enviar", "transferir", "quiero", "pásame los datos", "pasame la cuenta", "ticket"];
        const esAfirmativo = afirmativos.some(palabra => textoLower === palabra || textoLower.startsWith(palabra));

        if (esAfirmativo) {
          // GENERAR TICKET OFICIAL Y DISPARAR HANDOVER HUMANO
          const ticketOficial = this.generarTicketTexto(session.cotizacionActual);
          const alertaOperador = this.triggerHumanTakeover(session);

          // Se envía únicamente el ticket oficial (termina en la Fecha)
          const mensajeSalida = ticketOficial;

          return {
            tipo: "TICKET_GENERADO_HUMANO",
            alertaOperador,
            respuesta: mensajeSalida,
            session
          };
        } else if (texto === "2" || textoLower.includes("cotizar nuevamente") || textoLower.includes("recotizar") || textoLower.includes("otro monto") || textoLower.includes("nuevo")) {
          session.step = "ESPERANDO_MONTO";
          return {
            tipo: "BOT_TEXTO",
            respuesta: `🔄 *Cotizar nuevamente:*\n\nPor favor escribe el monto que quieres enviar o recibir:`,
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
            respuesta: `⚠️ Escribir el número adecuado:\n\n1️⃣ Proceder con el envío\n2️⃣ Cotizar nuevamente\n3️⃣ Hablar con un asesor`,
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
  generarRespuestaCotizacion(session, monto, tipo = "ENVIAR") {
    const cot = this.calcularCotizacion(session.ruta, monto, tipo);
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
Escribir el número adecuado:

1️⃣ Proceder con el envío
2️⃣ Cotizar nuevamente
3️⃣ Hablar con un asesor`;

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

1️⃣ 🇦🇷 ➔ 🇵🇪 *Argentina a Perú* (Pagas en Pesos ➔ Reciben Soles)
   _Cambio pesos: ${this.cambioPesosArgPeru.toLocaleString("es")} | Cambio soles: ${this.cambioSolesArgPeru}_

2️⃣ 🇵🇪 ➔ 🇦🇷 *Perú a Argentina* (Pagas en Soles ➔ Reciben Pesos)
   _Cambio soles: ${this.cambioSolesPeruArg} | Cambio pesos: ${this.cambioPesosPeruArg.toLocaleString("es")}_

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
