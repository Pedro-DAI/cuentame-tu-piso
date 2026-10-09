// precios.js — tabla de precios medios (€/m²) del Portal Estadístico del Notariado.
// Se usa para dar un RANGO orientativo, nunca una cifra exacta.
// IMPORTANTE: los datos no están aún unificados en filtro/fecha (ver traspaso) — 08006 y 08021
// vienen de la extracción de oct-2026 (2ª mano, ago-2025 a jul-2026); el resto, de abril de 2026.

// Barcelona ciudad, por código postal.
const BCN_CP = {
        "08002": { pm2: 4226, zona: "Barrio Gótico" },
        "08003": { pm2: 4567, zona: "El Born" },
        "08005": { pm2: 5605, zona: "Poblenou" },
        "08006": { pm2: 5780, zona: "Sant Gervasi" },
        "08009": { pm2: 6134, zona: "Eixample Dreta" },
        "08011": { pm2: 5646, zona: "Eixample Esquerra" },
        "08012": { pm2: 5227, zona: "Gràcia" },
        "08014": { pm2: 4352, zona: "Sants" },
        "08017": { pm2: 6305, zona: "Sarrià" },
        "08021": { pm2: 7002, zona: "Sant Gervasi-La Bonanova" },
        "08022": { pm2: 5906, zona: "Sant Gervasi-Bonanova" },
        "08026": { pm2: 4167, zona: "Sant Martí" },
        "08029": { pm2: 5449, zona: "Les Corts" },
        "08032": { pm2: 3375, zona: "Horta-Guinardó" },
        "08034": { pm2: 6740, zona: "Pedralbes" },
        "08038": { pm2: 3153, zona: "Montjuïc" },
        "08042": { pm2: 2752, zona: "Nou Barris" },
};

// Área metropolitana, precio medio municipal, últimos 12 meses disponibles (captura de octubre de 2026).
// Tipo de construcción y de finca: "Todos". Un municipio mezcla zonas muy distintas, por eso el rango es más ancho.
const MUNIS = {
        "Badalona": 2897,
        "Santa Coloma de Gramenet": 2470,
        "Sant Adrià de Besòs": 2858,
        "Montgat": 3281,
        "Tiana": 3517,
        "El Masnou": 3434,
        "Montcada i Reixac": 2419,
        "Cerdanyola del Vallès": 2880,
        "L'Hospitalet de Llobregat": 2880,
        "Cornellà de Llobregat": 2853,
        "Esplugues de Llobregat": 4861,
        "Sant Feliu de Llobregat": 3532,
        "Santa Coloma de Cervelló": 3402,
        "Sant Boi de Llobregat": 2833,
        "El Prat de Llobregat": 3088,
        "Viladecans": 2984,
        "Gavà": 3249,
        "Sant Climent de Llobregat": 2077,
        "Torrelles de Llobregat": 2005,
        "Cervelló": 1891,
        "Vallirana": 1900,
        "La Palma de Cervelló": 1763,
        "Begues": 2619,
        "Barcelona": 4788,
};

function norm(t) {
        return String(t || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/['’`´\-.,;:()]/g, " ").replace(/\s+/g, " ").trim();
}

const ALIAS = {
        "hospitalet": "L'Hospitalet de Llobregat",
        "l hospitalet": "L'Hospitalet de Llobregat",
        "santa coloma de gramenet": "Santa Coloma de Gramenet",
        "santa coloma": "Santa Coloma de Gramenet",
        "santa coloma de cervello": "Santa Coloma de Cervelló",
        "sant adria": "Sant Adrià de Besòs",
        "cornella": "Cornellà de Llobregat",
        "esplugues": "Esplugues de Llobregat",
        "sant feliu": "Sant Feliu de Llobregat",
        "sant boi": "Sant Boi de Llobregat",
        "el prat": "El Prat de Llobregat",
        "prat de llobregat": "El Prat de Llobregat",
        "masnou": "El Masnou",
        "montcada": "Montcada i Reixac",
        "cerdanyola": "Cerdanyola del Vallès",
        "la palma de cervello": "La Palma de Cervelló",
        "sant climent": "Sant Climent de Llobregat",
        "torrelles": "Torrelles de Llobregat",
};
for (const m of Object.keys(MUNIS)) ALIAS[norm(m)] = m;

// -> { tipo: "ok", pm2, nivel: "cp" | "municipio", zona }
//  | { tipo: "pedir_cp", motivo: "barcelona_sin_barrio" | "zona_no_reconocida" }
//  | { tipo: "no" }
// "zona_no_reconocida" significa que no hay forma de saber, por la tabla, si el piso está dentro del
// área que cubrimos — puede ser una calle de Barcelona que no está en la lista, o puede ser otra ciudad
// entera. Quien llama a buscarPrecio debe comprobar esto antes de dar una valoración de respaldo
// (ver zonaFueraDeBarcelona en whatsapp.js): "barcelona_sin_barrio" en cambio ya es Barcelona seguro.
function buscarPrecio(datos) {
        datos = datos || {};
        const texto = norm((datos.zona || "") + " " + (datos.municipio || ""));
        const cpDato = String(datos.codigo_postal || "").match(/08\d{3}/);
        const cpTexto = texto.match(/\b08\d{3}\b/);
        const cp = (cpDato && cpDato[0]) || (cpTexto && cpTexto[0]) || null;
        if (cp && BCN_CP[cp]) return { tipo: "ok", pm2: BCN_CP[cp].pm2, nivel: "cp", zona: BCN_CP[cp].zona };

    const claves = Object.keys(ALIAS).sort((a, b) => b.length - a.length);
        for (const k of claves) {
                    if (new RegExp("(^| )" + k + "( |$)").test(texto)) {
                                    const muni = ALIAS[k];
                                    // "Barcelona" a secas sin barrio reconocible: mejor pedir el código postal que dar un rango muy ancho.
                        if (muni === "Barcelona" && !cp) return { tipo: "pedir_cp", motivo: "barcelona_sin_barrio" };
                                    return { tipo: "ok", pm2: MUNIS[muni], nivel: "municipio", zona: muni };
                    }
        }
        if (cp) return { tipo: "no" }; // ya tenemos un código postal y no está en la tabla: no insistimos más
    if (!texto.trim()) return { tipo: "no" }; // no hay ni zona ni municipio: no hay nada que preguntar
    // Zona no reconocida (calle, barrio no listado, etc.): puede ser Barcelona o puede ser cualquier otro
    // sitio. Pedimos el CP, pero antes hay que comprobar que no está claramente fuera del área.
    return { tipo: "pedir_cp", motivo: "zona_no_reconocida" };
}

module.exports = { buscarPrecio, BCN_CP, MUNIS };
