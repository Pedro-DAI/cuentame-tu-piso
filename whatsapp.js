// whatsapp.js — flujo "Cuéntame tu piso" dentro de WhatsApp (Meta Cloud API)
// Se monta desde server.js con:  require("./whatsapp")(app);
const crypto = require("crypto");
const express = require("express");
const { procesarAudio, transcribirAudio, extraerDatos, MAKE_WEBHOOK_URL } = require("./voz");
const { buscarPrecio } = require("./precios");

const GRAPH = "https://graph.facebook.com/v21.0";
const TTL_MS = 24 * 60 * 60 * 1000;

// Estado en memoria por teléfono (se pierde si Railway reinicia; vale para la prueba)
const estado = new Map();
const vistos = new Set();
const colas = new Map();

const T = {
        consentimiento:
                    "Hola, soy Pedro, de Somos Vera. Para valorar tu piso voy a guardar tu voz y lo que me cuentes, solo para prepararte la valoración y llamarte. ¿Estás de acuerdo?",
        consentimientoConAudio:
                    "Hola, soy Pedro, de Somos Vera. Ya tengo tu audio. Antes de escucharlo: para valorar tu piso guardaré tu voz y lo que me cuentes, solo para prepararte la valoración y llamarte. ¿Estás de acuerdo?",
        escuchando: "Gracias. Lo estoy escuchando, dame un momento…",
        pideAudio:
                    "Perfecto. Mantén pulsado el micrófono (abajo a la derecha) y cuéntame tu piso como a un conocido: dónde está, cuántos metros tiene, qué planta, si hay ascensor, cómo está y por qué piensas vender. Cuando termines, suelta.",
        noConsiente: "Sin problema. Si cambias de idea, escríbeme cuando quieras.",
        noEntendido:
                    "No he podido escuchar bien el audio. ¿Me lo mandas otra vez, hablando un poco más cerca del móvil?",
        zona: "¿En qué barrio o calle está el piso? Puedes decírmelo en un audio o escribirlo.",
        metros: "¿Cuántos metros cuadrados tiene, más o menos? Puedes decírmelo en un audio o escribir el número.",
        metrosMal: "No he entendido el número. Escribe solo los metros, por ejemplo: 85",
        planta: "¿En qué planta está? Puedes decírmelo en un audio o escribirlo. Por ejemplo: bajo, 3º o ático.",
        ascensor: "¿El edificio tiene ascensor? Pulsa un botón o dímelo en un audio.",
        cp: "¿Cuál es el código postal del piso? Por ejemplo: 08022. Si no lo sabes, escribe «no sé».",
        cpNoEntendido:
                    "No he pillado bien el código postal. ¿Puedes escribirlo en números, por ejemplo 08022? Si no lo sabes, escribe «no sé».",
        usaBotones: "Pulsa uno de los botones de arriba, por favor.",
        repite: "No te he entendido bien. ¿Me lo repites en otro audio, o lo escribes?",
        extra: "Anotado, se lo paso a Pedro.",
};

const MARGEN_CP = 0.10;
const MARGEN_MUNICIPIO = 0.15;

function dato(v) { return v == null || v === "" ? "—" : v; }
function miles(n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, "."); }
function a5000(n) { return Math.round(n / 5000) * 5000; }

function cola(from, fn) {
        const previa = colas.get(from) || Promise.resolve();
        const sig = previa.then(fn).catch((e) => console.error("wa", e.message));
        colas.set(from, sig);
        return sig;
}

async function api(body) {
        const id = process.env.WHATSAPP_PHONE_ID, token = process.env.WHATSAPP_TOKEN;
        if (!id || !token) { console.error("WhatsApp: faltan WHATSAPP_PHONE_ID / WHATSAPP_TOKEN"); return; }
        const r = await fetch(`${GRAPH}/${id}/messages`, {
                    method: "POST",
                    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
                    body: JSON.stringify({ messaging_product: "whatsapp", ...body }),
        });
        if (!r.ok) console.error("WhatsApp envío", r.status, await r.text());
}
const texto = (to, body) => api({ to, type: "text", text: { body } });
const botones = (to, body, lista) =>
        api({
                    to, type: "interactive",
                         interactive: {
                                         type: "button", body: { text: body },
                                         action: { buttons: lista.map(([id, title]) => ({ type: "reply", reply: { id, title } })) },
                         },
        });

async function descargarAudio(mediaId) {
        const token = process.env.WHATSAPP_TOKEN;
        const meta = await fetch(`${GRAPH}/${mediaId}`, { headers: { Authorization: "Bearer " + token } });
        if (!meta.ok) throw new Error("media meta " + meta.status);
        const { url, mime_type } = await meta.json();
        const f = await fetch(url, { headers: { Authorization: "Bearer " + token } });
        if (!f.ok) throw new Error("media descarga " + f.status);
        return { buffer: Buffer.from(await f.arrayBuffer()), contentType: (mime_type || "audio/ogg").split(";")[0] };
}

// Rango orientativo a partir de la tabla de precios (precios.js). null si no hay dato fiable.
function estimarRango(datos) {
        const precio = buscarPrecio(datos);
        if (precio.tipo !== "ok" || !(Number(datos.metros) >= 10)) return null;
        const m = precio.nivel === "cp" ? MARGEN_CP : MARGEN_MUNICIPIO;
        const base = precio.pm2 * Number(datos.metros);
        const lo = a5000(base * (1 - m)), hi = a5000(base * (1 + m));
        return `entre ${miles(lo)} y ${miles(hi)} €`;
}

async function avisarPedro(s, from, extra) {
        const d = s.datos || {};
        const payload = {
                    nombre: s.nombre || "", telefono: "+" + from, email: "", fuente: "whatsapp",
                    municipio: d.zona || "", resultado_score: "", resumen: d.resumen || "",
                    transcripcion: s.transcripcion || "", datos_formulario: d, consentimiento: true,
                    metros: d.metros || "", planta: d.planta || "", ascensor: d.ascensor || "",
                    estado: d.estado || "", motivo: d.motivo || "", urgencia: d.urgencia || "",
                    ...extra,
        };
        const r = await fetch(MAKE_WEBHOOK_URL, {
                    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
        });
        if (!r.ok) console.error("Make webhook", r.status);
}

function ev(nombre, from) {
        console.log(JSON.stringify({ voz_evento: nombre, from_tail: from.slice(-4), t: new Date().toISOString() }));
}

// Procesa la descripción principal (audio o texto largo) y sigue el flujo
async function procesarDescripcion(s, from, entrada) {
        try {
                    if (entrada.tipo === "audio") {
                                    const { buffer, contentType } = await descargarAudio(entrada.mediaId);
                                    const r = await procesarAudio(buffer, contentType);
                                    s.datos = r.datos || {};
                                    s.transcripcion = r.transcripcion;
                    } else {
                                    s.datos = (await extraerDatos(entrada.texto)) || {};
                                    s.transcripcion = entrada.texto;
                    }
        } catch (e) {
                    console.error("wa descripcion", e.message);
                                return texto(from, T.noEntendido);
        }
        return siguientePaso(s, from);
}

// Pregunta por lo primero que falte; si no falta nada, cierra
async function siguientePaso(s, from) {
        const d = s.datos;
        if (!d.zona) { s.paso = "zona"; return texto(from, T.zona); }
        if (!d.metros) { s.paso = "metros"; return texto(from, T.metros); }
        // Planta y ascensor no entran en el cálculo del precio (solo zona/CP y metros):
    // si el audio los menciona se guardan para el resumen, pero no se bloquea la conversación pidiéndolos.
    const precio = buscarPrecio(d);
        if (precio.tipo === "pedir_cp" && !s.cpPreguntado) {
                    s.cpPreguntado = true;
                    s.paso = "cp";
                    return texto(from, T.cp);
        }

s.paso = "listo";
        const rango = estimarRango(d);
        const ascensorTxt = d.ascensor === "si" ? "Sí" : d.ascensor === "no" ? "No" : "—";
        const resumen =
                    `Esto es lo que he entendido:\n• Zona: ${dato(d.zona)}\n• Metros: ${dato(d.metros)}\n• Planta: ${dato(d.planta)}\n• Ascensor: ${ascensorTxt}\n• Estado: ${dato(d.estado)}`;
        const cierre = rango
        ? `Con estos datos, una primera aproximación: ${rango}. Es orientativa: depende de la planta, el estado, la luz y otros detalles que Pedro valora al verlo. Pedro te llama hoy para afinarla.`
                    : "Pedro ya tiene tus datos y te llamará hoy con tu valoración. Si algo no es correcto, escríbemelo aquí.";
        await texto(from, resumen + "\n\n" + cierre);
        await avisarPedro(s, from, {});
        ev("wa_lead_enviado", from);
}

async function procesarEntrada(msg, nombre) {
        const from = msg.from;
        const txt = msg.type === "text" && msg.text ? (msg.text.body || "").trim() : "";
        let s = estado.get(from);
        if (s && Date.now() - s.t > TTL_MS) { estado.delete(from); s = null; }
        if (s && /^reiniciar$/i.test(txt)) { estado.delete(from); s = null; } // para volver a probar sin esperar 24h
if (!s) { s = { paso: "inicio", datos: {}, nombre, t: Date.now() }; estado.set(from, s); }
        s.t = Date.now();
        if (nombre) s.nombre = nombre;

const boton = msg.type === "interactive" && msg.interactive && msg.interactive.button_reply
        ? msg.interactive.button_reply.id : null;

const consentBotones = [["consent_si", "Sí, de acuerdo"], ["consent_no", "No, gracias"]];
        // Si manda el audio (o una descripción larga) ANTES de aceptar, lo guardamos
// para no pedírselo dos veces: el anuncio Click-to-WhatsApp invita a mandar la nota de voz directamente.
const guardarPendiente = () => {
        if (msg.type === "audio" && msg.audio) s.pendiente = { tipo: "audio", mediaId: msg.audio.id };
        else if (txt.length >= 40) s.pendiente = { tipo: "texto", texto: txt };
};

// 1) Inicio y consentimiento
if (s.paso === "inicio" || (s.paso === "fin_sin_consentir" && !boton)) {
        s.paso = "consentimiento";
        ev("wa_inicio", from);
        guardarPendiente();
        return botones(from, s.pendiente ? T.consentimientoConAudio : T.consentimiento, consentBotones);
}
        if (s.paso === "consentimiento") {
                    if (boton === "consent_si") {
                                    ev("wa_consentimiento", from);
                                    if (s.pendiente) {
                                                        const p = s.pendiente; delete s.pendiente;
                                                        s.paso = "audio";
                                                        await texto(from, T.escuchando);
                                                        return procesarDescripcion(s, from, p);
                                    }
                                    s.paso = "audio"; return texto(from, T.pideAudio);
                    }
                    if (boton === "consent_no") { s.paso = "fin_sin_consentir"; delete s.pendiente; return texto(from, T.noConsiente); }
                    guardarPendiente();
                    return botones(from, s.pendiente ? T.consentimientoConAudio : T.consentimiento, consentBotones);
        }

// 2) Descripción principal: audio o, si prefiere escribir, un texto largo
if (s.paso === "audio") {
        if (msg.type === "audio" && msg.audio) {
                    ev("wa_audio_recibido", from);
                    return procesarDescripcion(s, from, { tipo: "audio", mediaId: msg.audio.id });
        }
        if (txt.length >= 40) {
                    ev("wa_texto_recibido", from);
                    return procesarDescripcion(s, from, { tipo: "texto", texto: txt });
        }
        return texto(from, T.pideAudio);
}

// 3) Datos que faltan (por texto, audio o botón) — solo zona y metros bloquean, son los únicos que entran en el precio
if (["zona", "metros"].includes(s.paso)) {
        const campo = s.paso;
        if (msg.type === "audio") {
                    try {
                                    const { buffer, contentType } = await descargarAudio(msg.audio.id);
                                    const t = await transcribirAudio(buffer, contentType);
                                    const d2 = t ? await extraerDatos(t) : {};
                                    s.transcripcion = (s.transcripcion || "") + "\n[" + campo + "] " + t;
                                    for (const k of ["zona", "metros", "planta", "ascensor", "municipio", "codigo_postal"]) {
                                                        if (!s.datos[k] && d2[k] != null && d2[k] !== "") s.datos[k] = d2[k];
                                    }
                    } catch (e) {
                                    console.error("wa audio dato", e.message);
                                    return texto(from, T.noEntendido);
                    }
                    if (!s.datos[campo] || (campo === "ascensor" && s.datos.ascensor !== "si" && s.datos.ascensor !== "no")) {
                                    return texto(from, T.repite);
                    }
                    return siguientePaso(s, from);
        }
        if (campo === "ascensor") {
                    if (boton === "asc_si") s.datos.ascensor = "si";
                    else if (boton === "asc_no") s.datos.ascensor = "no";
                    else return botones(from, T.ascensor, [["asc_si", "Sí"], ["asc_no", "No"]]);
                    return siguientePaso(s, from);
        }
        if (campo === "metros") {
                    const n = parseInt((txt.match(/\d+/) || [])[0], 10);
                    if (!(n >= 10 && n <= 2000)) return texto(from, T.metrosMal);
                    s.datos.metros = n; return siguientePaso(s, from);
        }
        if (!txt) return texto(from, T[campo]);
        if (campo === "zona" && txt.length < 3) return texto(from, T.zona);
        s.datos[campo] = txt; return siguientePaso(s, from);
}

// 3b) Código postal (solo cuando el barrio no basta para dar un precio)
if (s.paso === "cp") {
        let t = txt;
        if (msg.type === "audio") {
                    try {
                                    const { buffer, contentType } = await descargarAudio(msg.audio.id);
                                    t = await transcribirAudio(buffer, contentType);
                    } catch (e) { return texto(from, T.noEntendido); }
        }
        const m = String(t || "").replace(/\s+/g, "").match(/08\d{3}/);
        if (m) {
                    s.datos.codigo_postal = m[0];
        } else if (!/no\s*s[eé]/i.test(t || "") && !s.cpReintento) {
                    // No hemos entendido el CP (típico con audio) y no ha dicho "no sé": insistimos una vez.
        s.cpReintento = true;
                    return texto(from, T.cpNoEntendido);
        }
        return siguientePaso(s, from); // si no lo sabe (o ya hemos insistido una vez), sigue sin precio y cierra con la llamada
}

// 4) Ya cerrado: no se reenvía nada más a Pedro (antes mandaba un email por cada mensaje)
if (s.paso === "listo") return;
}

module.exports = function (app) {
        app.get("/whatsapp", (req, res) => {
                    const ok = req.query["hub.mode"] === "subscribe" &&
                                    req.query["hub.verify_token"] === process.env.WHATSAPP_VERIFY_TOKEN;
                    if (ok) return res.status(200).send(req.query["hub.challenge"]);
                    res.sendStatus(403);
        });

        app.post("/whatsapp", express.raw({ type: () => true, limit: "5mb" }), (req, res) => {
                    const secret = process.env.META_APP_SECRET;
                    if (secret) {
                                    const firma = req.get("x-hub-signature-256") || "";
                                    const esperada = "sha256=" + crypto.createHmac("sha256", secret).update(req.body).digest("hex");
                                    const a = Buffer.from(firma), b = Buffer.from(esperada);
                                    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.sendStatus(401);
                    }
                    res.sendStatus(200);
                    let body;
                    try { body = JSON.parse(req.body.toString("utf8")); } catch (_) { return; }
                    for (const entry of body.entry || []) {
                                    for (const ch of entry.changes || []) {
                                                        const v = ch.value || {};
                                                        const nombre = v.contacts && v.contacts[0] && v.contacts[0].profile && v.contacts[0].profile.name;
                                                        for (const msg of v.messages || []) {
                                                                                if (vistos.has(msg.id)) continue;
                                                                                vistos.add(msg.id);
                                                                                if (vistos.size > 5000) vistos.clear();
                                                                                cola(msg.from, () => procesarEntrada(msg, nombre));
                                                        }
                                    }
                    }
        });
};
module.exports._test = { procesarEntrada, estado };
