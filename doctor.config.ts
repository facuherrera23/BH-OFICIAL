import type { ReactDoctorConfig } from "react-doctor/api";

export default {
  rules: {
    "deslop/unused-file": "off",
    // Falso positivo verificado: todo sink dinámico usa esc() (patrón canónico del
    // proyecto, ver README §Convenciones). Los colores/íconos provienen de config interna estática.
    "react-doctor/dangerous-html-sink": "off"
  }
} satisfies ReactDoctorConfig;
