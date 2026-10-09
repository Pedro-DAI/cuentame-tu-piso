// voz.js — "Cuéntame tu piso" (Somos Vera)
// Se monta desde index.js con:  require("./voz")(app);
// Sin dependencias nuevas: usa fetch/FormData/Blob de Node >= 18.

const express = require("express");
const path = require("path");

const MAKE_WEBHOOK_URL =
    process.env.MAKE_WEBHOOK_URL ||
    "https://hook.eu1.make.com/n9tsrymn6m1k61u84isjedoggxjs5e4a";

const EXTRACTION_PROMPT = `Eres un asistente de un agente inmobiliario de Barcelona.
Recibes la transcripción de un propietario contando su piso. Extrae SOLO lo que dice explícitamente. Si algo no lo dice, pon null. No inventes nada.
Devuelve exclusivamente un JSON con estas claves:
- zona: barrio o calle (string o null)
- municipio: municipio o ciudad si lo dice explícitamente, por ejemplo "Barcelona", "Badalona" o "Sant Cugat" (string o null)
- codigo_postal: código postal de 5 cifras si lo dice explícitamente, por ejemplo "08021" (string o null)
- metros: metros cuadrados como número (number o null)
- planta: planta como texto (string o null)
- ascensor: "si", "no" o null
- estado: estado del piso en pocas palabras (string o null)
- reformas: reformas o mejoras que menciona (string o null)
- motivo: por qué quiere vender (string o null)
- urgencia: "alta", "media", "baja" o null, según lo que se desprenda de sus palabras
- consulta_a_otros: true si menciona que debe consultarlo con familia/socios, si no false
- resumen: 3 líneas máximo, en español, para que el agente prepare la llamada (qué tiene, por qué vende, qué le preocupa)
- faltan: lista con los campos críticos que faltan de ["zona","metros","planta"]`;

function extension(contentType) {
    const t = (contentType || "").toLowerCase();
    if (t.includes("mp4") || t.includes("aac") || t.includes("m4a")) return "m4a";
    if (t.includes("ogg")) return "ogg";
    if (t.includes("wav")) return "wav";
    if (t.includes("mpeg") || t.includes("mp3")) return "mp3";
    return "webm";
}

// Límite simple por IP para que nadie dispare el gasto de OpenAI (20 audios/hora)
const usos = new Map();
function limitar(req, res, next) {
    const ip = (req.headers["x-forwarded-for"] || req.ip || "").split(",")[0].trim();
    const ahora = Date.now();
    const lista = (usos.get(ip) || []).filter((t) => ahora - t < 3600000);
    if (lista.length >= 20) return res.status(429).json({ error: "Demasiados intentos" });
    lista.push(ahora);
    usos.set(ip, lista);
    if (usos.size > 5000) usos.clear();
    next();
}

module.exports = function (app) {
    const cors = (req, res, next) => {
          res.set("Access-Control-Allow-Origin", "*");
          res.set("Access-Control-Allow-Headers", "Content-Type");
          res.set("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
          if (req.method === "OPTIONS") return res.sendStatus(204);
          next();
    };

    // Página
    app.get("/cuentame-tu-piso", (req, res) => {
          res.sendFile(path.join(__dirname, "cuentame-tu-piso.html"));
    });

    // 1) Audio -> transcripción -> datos
    app.options("/voz/procesar", cors);
    app.post(
          "/voz/procesar",
          cors,
          limitar,
          express.raw({ type: () => true, limit: "25mb" }),
          async (req, res) => {
                  if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: "Falta OPENAI_API_KEY" });
                  if (!req.body || !req.body.length) return res.status(400).json({ error: "Audio vacío" });
                  try {
                            const r = await procesarAudio(req.body, req.headers["content-type"] || "audio/webm");
                            res.json(r);
                  } catch (e) {
                            console.error("voz/procesar", e.message);
                            const noEntendido = e.message === "Audio no entendido";
                            res.status(noEntendido ? 422 : 502).json({ error: noEntendido ? "No se entendió el audio" : "No se pudo procesar" });
                  }
          }
        );

    // 2) Lead confirmado -> Make (email a Pedro)
    app.options("/voz/lead", cors);
    app.post("/voz/lead", cors, limitar, express.json({ limit: "1mb" }), async (req, res) => {
          try {
                  const b = req.body || {};
                  if (!b.telefono) return res.status(400).json({ error: "Falta teléfono" });
                  const payload = {
                            nombre: b.nombre || "",
                            telefono: b.telefono,
                            email: "",
                            fuente: "cuentame-tu-piso",
                            municipio: (b.datos && b.datos.zona) || "",
                            resultado_score: "",
                            resumen: b.resumen || "",
                            transcripcion: b.transcripcion || "",
                            datos_formulario: b.datos || {},
                            metros: (b.datos && b.datos.metros) || "",
                            planta: (b.datos && b.datos.planta) || "",
                            ascensor: (b.datos && b.datos.ascensor) || "",
                            estado: (b.datos && b.datos.estado) || "",
                            motivo: (b.datos && b.datos.motivo) || "",
                            urgencia: (b.datos && b.datos.urgencia) || "",
                  };
                  const r = await fetch(MAKE_WEBHOOK_URL, {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify(payload),
                  });
                  if (!r.ok) {
                            console.error("Make webhook", r.status);
                            return res.status(502).json({ error: "No se pudo avisar" });
                  }
                  console.log(JSON.stringify({ voz_evento: "lead_enviado", sid: b.sid }));
                  res.json({ ok: true });
          } catch (e) {
                  console.error("voz/lead", e);
                  res.status(500).json({ error: "Error interno" });
          }
    });

    // 3) Eventos del embudo (se ven en los logs de Railway)
    app.options("/voz/evento", cors);
    app.post("/voz/evento", cors, express.text({ type: () => true, limit: "10kb" }), (req, res) => {
          try {
                  const e = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
                  console.log(JSON.stringify({ voz_evento: e.evento, sid: e.sid, extra: e.extra || null, t: new Date().toISOString() }));
          } catch (_) {}
          res.sendStatus(204);
    });
};

// Reutilizable desde whatsapp.js
async function transcribirAudio(buffer, contentType) {
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new Error("Falta OPENAI_API_KEY");
    const ct = contentType || "audio/ogg";
    const form = new FormData();
    form.append("file", new Blob([buffer], { type: ct }), "audio." + extension(ct));
    form.append("model", "whisper-1");
    form.append("prompt", "Propietario hablando de su piso en Barcelona: barrio, metros cuadrados, planta, ascensor, reformas.");
    const tr = await fetch("https://api.openai.com/v1/audio/transcriptions", {
          method: "POST", headers: { Authorization: "Bearer " + key }, body: form,
    });
    if (!tr.ok) throw new Error("Whisper " + tr.status);
    return ((await tr.json()).text || "").trim();
}

async function extraerDatos(texto) {
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new Error("Falta OPENAI_API_KEY");
    const ex = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
          body: JSON.stringify({
                  model: "gpt-4o-mini", temperature: 0, response_format: { type: "json_object" },
                  messages: [{ role: "system", content: EXTRACTION_PROMPT }, { role: "user", content: texto }],
          }),
    });
    if (!ex.ok) throw new Error("Extraccion " + ex.status);
    return normalizar(JSON.parse((await ex.json()).choices[0].message.content));
}

// El modelo a veces devuelve "unos 80 m2", "Sí" o "" — lo dejamos limpio
function normalizar(d) {
    d = d && typeof d === "object" ? d : {};
    for (const k of Object.keys(d)) if (d[k] === "") d[k] = null;
    if (d.metros != null) {
          const n = parseInt(String(d.metros).replace(/\./g, "").match(/\d+/) || "", 10);
          d.metros = n >= 10 && n <= 2000 ? n : null;
    }
    if (d.ascensor != null) {
          const a = String(d.ascensor).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
          d.ascensor = a.startsWith("si") ? "si" : a.startsWith("no") ? "no" : null;
    }
    if (d.codigo_postal != null) {
              const cp = String(d.codigo_postal).match(/08\d{3}/);
              d.codigo_postal = cp ? cp[0] : null;
    }
    const faltan = ["zona", "metros", "planta"].filter((k) => d[k] == null);
    d.faltan = faltan;
    return d;
}

// audio (Buffer) -> { transcripcion, datos }
async function procesarAudio(buffer, contentType) {
    const transcripcion = await transcribirAudio(buffer, contentType);
    if (transcripcion.length < 10) throw new Error("Audio no entendido");
    const datos = await extraerDatos(transcripcion);
    return { transcripcion, datos };
}

// Comprueba si una zona/municipio que ha dicho el propietario está CLARAMENTE fuera de Barcelona
// y su área metropolitana, para no darle una valoración calculada con precios de Barcelona a un piso
// que no lo es (p. ej. un pueblo de Granada). Ante la duda, o si falla la llamada, decimos que NO está
// fuera: preferimos pedir el código postal de más a negarle a alguien una valoración real.
async function zonaFueraDeBarcelona(texto) {
    const t = String(texto || "").trim();
    if (!t) return false;
    const key = process.env.OPENAI_API_KEY;
    if (!key) return false;
    try {
          const r = await fetch("https://api.openai.com/v1/chat/completions", {
                  method: "POST",
                  headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
                  body: JSON.stringify({
                            model: "gpt-4o-mini", temperature: 0, response_format: { type: "json_object" },
                            messages: [
                              {
                                            role: "system",
                                            content:
                                                            "Te doy el nombre de un barrio, calle o municipio que un propietario ha dicho sobre su piso. " +
                                                            'Responde SOLO con JSON {"fuera": true|false}: true si ese lugar está CLARAMENTE fuera de ' +
                                                            "Barcelona ciudad y su área metropolitana (otra provincia, otra comunidad autónoma u otro país); " +
                                                            "false si es Barcelona o su área metropolitana, o si no tienes información suficiente para estar seguro.",
                              },
                              { role: "user", content: t },
                                      ],
                  }),
          });
          if (!r.ok) return false;
          const j = JSON.parse((await r.json()).choices[0].message.content);
          return j.fuera === true;
    } catch (e) {
          console.error("zonaFueraDeBarcelona", e.message);
          return false;
    }
}

module.exports.transcribirAudio = transcribirAudio;
module.exports.extraerDatos = extraerDatos;
module.exports.normalizar = normalizar;
module.exports.procesarAudio = procesarAudio;
module.exports.zonaFueraDeBarcelona = zonaFueraDeBarcelona;
module.exports.MAKE_WEBHOOK_URL = MAKE_WEBHOOK_URL;
