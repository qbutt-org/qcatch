export function hasBrowserCheck(document: Document): boolean {
    const anubis = document.querySelector("script#anubis_challenge[type='application/json']")
        && document.querySelector("script#anubis-main[src*='/.within.website/x/cmd/anubis/']");
    const cloudflare = document.querySelector("#challenge-form, #cf-challenge-running")
        && document.querySelector("script[src*='/cdn-cgi/challenge-platform/']");
    const ddosGuard = document.querySelector("script[src*='check.ddos-guard.net/check.js']");
    const captcha = document.querySelector("form#captcha-form, form[action*='/captcha']");
    return Boolean(anubis || cloudflare || ddosGuard || captcha);
}
