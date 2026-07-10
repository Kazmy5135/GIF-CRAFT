import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./app/App";
import { SourceImageProvider } from "./features/source-image/SourceImageContext";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <SourceImageProvider>
        <App />
      </SourceImageProvider>
    </BrowserRouter>
  </StrictMode>,
);
