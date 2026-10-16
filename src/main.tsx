import { createElement } from "react";
import { mountApp } from "@fungi.computer/agar/react";
import { createQueryClient } from "@fungi.computer/agar/query";
import "@fungi.computer/caps/fonts.css";
import "./shed.css";
import { ShedApp } from "./shed-app.js";

const root = document.getElementById("shed-root");
if (!root) throw new Error("Shed root is missing");

mountApp(root, { name: "Shed", queryClient: createQueryClient() }, ({ app }) =>
  createElement(ShedApp, { app }),
);
