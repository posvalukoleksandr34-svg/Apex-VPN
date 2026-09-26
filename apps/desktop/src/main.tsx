import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./design/global.css";
import "./i18n";
import { App } from "./App";
import { startController } from "./app/controller";
import { createTransport } from "./platform";

const root = createRoot(document.getElementById("root")!);

createTransport().then((transport) => {
  startController(transport);
  root.render(
    <StrictMode>
      <App transportKind={transport.kind} />
    </StrictMode>,
  );
});
