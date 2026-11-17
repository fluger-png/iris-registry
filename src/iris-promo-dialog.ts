export const buildIrisPromoDialog = (session: string, csrf: string): string => `
  <style>
    .iris-promo-open{margin-top:2.2rem;max-width:100%;}
    .iris-promo-dialog{position:fixed;width:min(440px,calc(100% - 32px));max-height:calc(100% - 32px);margin:auto;padding:26px;border:1px solid var(--iris-line-strong);border-radius:8px;background:var(--iris-surface);color:var(--iris-text);text-align:left;}
    .iris-promo-dialog::backdrop{background:rgba(0,0,0,.72);}
    .iris-promo-dialog h2{font-size:20px;margin:0;}
    .iris-promo-head{display:flex;align-items:center;justify-content:space-between;gap:12px;}
    .iris-promo-close{display:grid;place-items:center;width:36px;height:36px;padding:0;border:1px solid transparent;border-radius:4px;background:none;color:var(--iris-text);cursor:pointer;}
    .iris-promo-close:hover{border-color:var(--iris-line-strong);}
    .iris-promo-dialog p{font-size:16px;margin:14px 0;}
    .iris-promo-dialog .iris-promo-value{display:block;width:100%;padding:12px;border:1px solid var(--iris-line-strong);background:var(--iris-black);color:var(--iris-gold-bright);font:13px monospace;}
    .iris-promo-actions{margin-top:14px;}
    .iris-promo-dialog [hidden]{display:none !important;}
    @media(max-width:400px){.iris-promo-dialog{padding:16px;}}
  </style>
  <button class="btn iris-promo-open" id="iris-promo-open" type="button" aria-haspopup="dialog" aria-controls="iris-promo-dialog">Redeem My Discount</button>
  <dialog class="iris-promo-dialog" id="iris-promo-dialog" aria-labelledby="iris-promo-title">
    <div class="iris-promo-head">
      <h2 id="iris-promo-title">Your IRIS Discount</h2>
      <form method="dialog"><button class="iris-promo-close" type="submit" aria-label="Close" title="Close" autofocus><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="m18 6-12 12M6 6l12 12"/></svg></button></form>
    </div>
    <p id="iris-promo-status" role="status"></p>
    <div id="iris-promo-result" hidden>
      <input class="iris-promo-value" id="iris-promo-code" aria-label="Discount code" readonly spellcheck="false" />
      <div class="iris-promo-actions"><button class="btn" id="iris-promo-copy" type="button">Copy Code</button></div>
    </div>
    <button class="btn secondary" id="iris-promo-retry" type="button" hidden>Try Again</button>
  </dialog>
  <script>
    (function () {
      const open = document.getElementById('iris-promo-open');
      const dialog = document.getElementById('iris-promo-dialog');
      const status = document.getElementById('iris-promo-status');
      const result = document.getElementById('iris-promo-result');
      const code = document.getElementById('iris-promo-code');
      const copy = document.getElementById('iris-promo-copy');
      const retry = document.getElementById('iris-promo-retry');
      const request = ${JSON.stringify({ session, csrf_token: csrf }).replace(/</g, "\\u003c")};
      let pending = false;
      async function redeem() {
        if (pending) return;
        pending = true;
        result.hidden = retry.hidden = true;
        code.value = '';
        copy.textContent = 'Copy Code';
        status.textContent = 'Getting your discount from Shopify...';
        try {
          const response = await fetch('/apps/iris/v3/promo/redeem', {
            method: 'POST', credentials: 'same-origin', cache: 'no-store',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify(request)
          });
          const data = await response.json().catch(() => null);
          if (!response.ok) {
            status.textContent = data?.message || 'The store returned an error (' + response.status + ').';
            retry.hidden = !(data?.retryable ?? (response.status >= 500));
            return;
          }
          if (!data?.code || !Number.isFinite(data.percent)) {
            status.textContent = 'The store did not return a discount code. Please try again.';
            retry.hidden = false;
            return;
          }
          code.value = data.code;
          status.textContent = data.percent + '% off one purchase. Use your account email at checkout.';
          result.hidden = false;
        } catch {
          status.textContent = 'Could not connect to the store. Please try again.';
          retry.hidden = false;
        } finally {
          pending = false;
        }
      }
      open.addEventListener('click', function () { dialog.showModal(); redeem(); });
      retry.addEventListener('click', redeem);
      copy.addEventListener('click', async function () {
        try {
          await navigator.clipboard.writeText(code.value);
          copy.textContent = 'Copied';
        } catch {
          code.focus();
          code.select();
        }
      });
    })();
  </script>`;
