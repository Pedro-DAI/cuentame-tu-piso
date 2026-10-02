const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => res.redirect("/cuentame-tu-piso"));
require("./voz")(app);

app.listen(PORT, () => console.log("Cuéntame tu piso activo en puerto " + PORT));
