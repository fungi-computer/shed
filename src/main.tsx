import { createElement } from "react";
import { mountApp } from "@fungi.computer/agar/react";
import { createQueryClient } from "@fungi.computer/agar/query";
import "@fungi.computer/caps/fonts.css";
import "./shed.css";
import { loadGhostty } from "./ghostty-runtime.js";
import { ShedApp } from "./shed-app.js";

const root = document.getElementById("shed-root");
if (!root) throw new Error("Shed root is missing");

// Start the wasm compile now; it overlaps the host handshake.
loadGhostty().catch((cause: unknown) => {
  console.error("Shed terminal operation failed", cause);
});

mountApp(root, { name: "Shed", queryClient: createQueryClient() }, ({ app }) =>
  createElement(ShedApp, { app }),
);
