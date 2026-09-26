/**
 * The page Stripe's hosted checkout and portal send the browser back to.
 * Static: no script, no cookies, nothing about the account. The state
 * itself arrives by webhook; the app refreshes when it regains focus.
 */
type Result = "success" | "cancel" | "portal";

const TEXT: Record<string, Record<Result, [string, string]>> = {
  en: {
    success: ["Payment received", "Your plan activates in a moment. You can close this tab and return to Meridian."],
    cancel: ["Checkout cancelled", "Nothing was charged. You can close this tab and return to Meridian."],
    portal: ["All set", "Your billing changes are saved. You can close this tab and return to Meridian."],
  },
  ru: {
    success: ["Оплата получена", "Тариф активируется через несколько секунд. Можно закрыть эту вкладку и вернуться в Meridian."],
    cancel: ["Оплата отменена", "Деньги не списаны. Можно закрыть эту вкладку и вернуться в Meridian."],
    portal: ["Готово", "Изменения оплаты сохранены. Можно закрыть эту вкладку и вернуться в Meridian."],
  },
  de: {
    success: ["Zahlung erhalten", "Dein Tarif wird gleich aktiviert. Du kannst diesen Tab schließen und zu Meridian zurückkehren."],
    cancel: ["Bezahlung abgebrochen", "Es wurde nichts berechnet. Du kannst diesen Tab schließen und zu Meridian zurückkehren."],
    portal: ["Erledigt", "Deine Zahlungsänderungen sind gespeichert. Du kannst diesen Tab schließen und zu Meridian zurückkehren."],
  },
  it: {
    success: ["Pagamento ricevuto", "Il piano si attiverà tra un attimo. Puoi chiudere questa scheda e tornare a Meridian."],
    cancel: ["Pagamento annullato", "Non è stato addebitato nulla. Puoi chiudere questa scheda e tornare a Meridian."],
    portal: ["Fatto", "Le modifiche di pagamento sono salvate. Puoi chiudere questa scheda e tornare a Meridian."],
  },
};

export function billingReturnPage(result: Result, acceptLanguage: string): string {
  const lang = acceptLanguage
    .split(",")
    .map((l) => l.trim().slice(0, 2).toLowerCase())
    .find((l) => l in TEXT) ?? "en";
  const [title, body] = TEXT[lang]![result];
  const tone = result === "cancel" ? "#8a93a8" : "#34c38f";
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Meridian</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; background: #0b0e14; color: #e8ebf2; }
  @media (prefers-color-scheme: light) { body { background: #f5f6f9; color: #141824; } main { background: #fff; } }
  main { max-width: 420px; margin: 24px; padding: 32px; border-radius: 22px; background: #10131a; text-align: center; box-shadow: 0 18px 48px rgba(0, 0, 0, .35); }
  .mark { width: 44px; height: 44px; margin: 0 auto 16px; border-radius: 50%; background: ${tone}; opacity: .9; }
  h1 { margin: 0 0 8px; font-size: 22px; }
  p { margin: 0; opacity: .75; }
</style>
</head>
<body>
<main>
  <div class="mark" aria-hidden="true"></div>
  <h1>${title}</h1>
  <p>${body}</p>
</main>
</body>
</html>`;
}
