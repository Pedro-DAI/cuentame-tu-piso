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
- zona: barrio, calle o municipio (string o null)
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
    express.raw({ type: () => true, limit: "25mb" }),
    async (req, res) => {
      try {
        const key = process.env.OPENAI_API_KEY;
        if (!key) return res.status(500).json({ error: "Falta OPENAI_API_KEY" });
        if (!req.body || !req.body.length) {
          return res.status(400).json({ error: "Audio vacío" });
        }

        const ct = req.headers["content-type"] || "audio/webm";
        const form = new FormData();
        form.append(
          "file",
          new Blob([req.body], { type: ct }),
          "audio." + extension(ct)
        );
        form.append("model", "whisper-1");
        form.append(
          "prompt",
          "Propietario hablando de su piso en Barcelona: barrio, metros cuadrados, planta, ascensor, reformas."
        );

        const tr = await fetch("https://api.openai.com/v1/audio/transcriptions", {
          method: "POST",
          headers: { Authorization: "Bearer " + key },
          body: form,
        });
        if (!tr.ok) {
          const detalle = await tr.text();
          console.error("Whisper error", tr.status, detalle);
          return res.status(502).json({ error: "No se pudo transcribir" });
        }
        const transcripcion = ((await tr.json()).text || "").trim();
        if (transcripcion.length < 10) {
          return res.status(422).json({ error: "No se entendió el audio", transcripcion });
        }

        const ex = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: "Bearer " + key,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "gpt-4o-mini",
            temperature: 0,
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: EXTRACTION_PROMPT },
              { role: "user", content: transcripcion },
            ],
          }),
        });
        if (!ex.ok) {
          const detalle = await ex.text();
          console.error("Extracción error", ex.status, detalle);
          return res.status(502).json({ error: "No se pudieron extraer los datos", transcripcion });
        }
        const datos = JSON.parse((await ex.json()).choices[0].message.content);
        res.json({ transcripcion, datos });
      } catch (e) {
        console.error("voz/procesar", e);
        res.status(500).json({ error: "Error interno" });
      }
    }
  );

  // 2) Lead confirmado -> Make (email a Pedro)
  app.options("/voz/lead", cors);
  app.post("/voz/lead", cors, express.json({ limit: "1mb" }), async (req, res) => {
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
