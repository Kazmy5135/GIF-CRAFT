import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./app/App";
import { SourceImageProvider } from "./features/source-image/SourceImageContext";
import { SequenceProvider } from "./features/sequence/SequenceContext";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <SourceImageProvider>
        <SequenceProvider>
          <App />
        </SequenceProvider>
      </SourceImageProvider>
    </BrowserRouter>
  </StrictMode>,
);
