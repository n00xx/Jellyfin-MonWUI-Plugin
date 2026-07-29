export function ensureSerrStyles() {
  if (document.getElementById("monwui-serr-styles")) return;

  const style = document.createElement("style");
  style.id = "monwui-serr-styles";
  style.textContent = `
    .monwui-serr-btn,
    .monwui-serr-search-bridge-btn,
    .monwui-serr-mini-btn {
      align-items: center;
      border: 0;
      border-radius: 12px;
      cursor: pointer;
      display: inline-flex;
      font: inherit;
      font-size: 13px;
      font-weight: 800;
      gap: 8px;
      justify-content: center;
      min-height: 40px;
      padding: 10px 14px;
      transition: transform .18s ease, background-color .18s ease, border-color .18s ease, opacity .18s ease;
      white-space: nowrap;
    }
    .monwui-serr-btn,
    .monwui-serr-mini-btn.primary {
      background: linear-gradient(135deg, #ffb703, #fb8500);
      color: #1b1f28;
    }
    .monwui-serr-4k-btn {
      background: linear-gradient(135deg, #e0f2fe, #38bdf8);
      color: #07131f;
    }
    .monwui-serr-search-bridge-btn,
    .monwui-serr-mini-btn {
      background: rgba(255,255,255,0.08);
      border: 1px solid rgba(255,255,255,0.12);
      color: #fff;
    }
    .monwui-serr-btn:hover,
    .monwui-serr-search-bridge-btn:hover,
    .monwui-serr-mini-btn:hover {
      transform: translateY(-1px);
    }
    .monwui-serr-btn:disabled,
    .monwui-serr-search-bridge-btn:disabled,
    .monwui-serr-mini-btn:disabled {
      cursor: wait;
      opacity: .72;
      transform: none;
    }
    .monwui-serr-btn.monwui-serr-requested,
    .monwui-serr-btn.monwui-serr-requested:disabled {
      cursor: default;
      opacity: 1;
    }
    .monwui-serr-search-bridge {
      align-items: center;
      display: flex;
      flex: 0 0 auto;
      flex-direction: column;
      gap: 10px;
      justify-content: center;
      margin-top: 10px;
      padding-bottom: 20px;
      order: 1;
      width: 100%;
    }
    .monwui-serr-search-bridge-actions {
      display: flex;
      justify-content: center;
      width: 100%;
    }
    .monwui-serr-search-bridge-btn {
      min-height: 42px;
      padding-inline: 16px;
    }
    .monwui-serr-local-results {
      background: rgba(12,14,20,0.88);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 20px;
      box-shadow: 0 18px 44px rgba(0,0,0,0.28);
      color: rgba(255,255,255,0.9);
      max-width: min(760px, 100%);
      padding: 12px;
      width: min(760px, 100%);
    }
    .monwui-serr-local-title {
      font-size: 13px;
      font-weight: 800;
      margin: 0 0 8px;
    }
    .monwui-serr-local-list {
      display: grid;
      gap: 8px;
    }
    .monwui-serr-local-item {
      align-items: center;
      background: rgba(255,255,255,0.06);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 12px;
      color: inherit;
      display: grid;
      gap: 10px;
      grid-template-columns: 34px minmax(0, 1fr);
      padding: 9px 10px;
      text-decoration: none;
      transition: transform .18s ease, border-color .18s ease, background-color .18s ease;
    }
    .monwui-serr-local-item:hover {
      background: rgba(255,255,255,0.08);
      border-color: rgba(255,183,3,0.42);
      transform: translateY(-1px);
    }
    .monwui-serr-local-item .material-icons {
      align-items: center;
      background: linear-gradient(135deg, rgba(255,183,3,0.22), rgba(251,133,0,0.18));
      border-radius: 8px;
      color: #fff3d2;
      display: inline-flex;
      height: 34px;
      justify-content: center;
      width: 34px;
    }
    .monwui-serr-local-item b,
    .monwui-serr-local-item small {
      display: block;
      min-width: 0;
      overflow-wrap: anywhere;
    }
    .monwui-serr-local-item small {
      color: rgba(255,255,255,0.72);
      font-size: 12px;
      margin-top: 2px;
    }
    #monwuiSerrModal {
      background:
        radial-gradient(circle at top left, rgba(255, 193, 7, 0.18), transparent 28%),
        linear-gradient(180deg, rgba(8, 10, 16, 0.72), rgba(7, 9, 15, 0.92));
      backdrop-filter: blur(14px);
      display: none;
      inset: 0;
      padding: 18px;
      position: fixed;
      z-index: 999999;
    }
    #monwuiSerrConfirmModal {
      background:
        radial-gradient(circle at top left, rgba(255, 193, 7, 0.18), transparent 28%),
        linear-gradient(180deg, rgba(8, 10, 16, 0.72), rgba(7, 9, 15, 0.92));
      backdrop-filter: blur(14px);
      display: none;
      inset: 0;
      padding: 18px;
      position: fixed;
      z-index: 1000001;
    }
    #monwuiSerrModal.open,
    #monwuiSerrConfirmModal.open {
      align-items: center;
      display: flex;
      justify-content: center;
    }
    .monwui-serr-card {
      background:
        linear-gradient(180deg, rgba(21, 25, 36, 0.96), rgba(10, 12, 18, 0.98));
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 24px;
      box-shadow: 0 28px 80px rgba(0,0,0,0.45);
      color: #f8f8fb;
      display: flex;
      flex-direction: column;
      max-height: min(820px, 92vh);
      max-width: 980px;
      overflow: hidden;
      width: min(980px, calc(100vw - 36px));
    }
    .monwui-serr-head,
    .monwui-serr-searchbar,
    .monwui-serr-footer {
      align-items: center;
      display: flex;
      gap: 10px;
      padding: 14px 24px;
    }
    .monwui-serr-head {
      background: linear-gradient(180deg, rgba(255,255,255,0.04), transparent);
      border-bottom: 1px solid rgba(255,255,255,0.06);
      justify-content: space-between;
      padding-top: 24px;
    }
    .monwui-serr-title {
      font-size: 28px;
      font-weight: 800;
      letter-spacing: 0;
      line-height: 1.18;
      margin: 0;
    }
    .monwui-serr-close {
      align-items: center;
      background: rgba(255,255,255,0.08);
      border: 0;
      border-radius: 8px;
      color: #fff;
      cursor: pointer;
      display: inline-flex;
      flex: 0 0 auto;
      font-size: 18px;
      height: 44px;
      justify-content: center;
      transition: transform .18s ease, background-color .18s ease, opacity .18s ease;
      width: 44px;
    }
    .monwui-serr-close:hover {
      transform: translateY(-1px);
    }
    .monwui-serr-searchbar {
      border-bottom: 1px solid rgba(255,255,255,0.08);
      flex-wrap: wrap;
    }
    .monwui-serr-input {
      background: rgba(255,255,255,0.06);
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 12px;
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.06);
      color: #fff;
      flex: 1;
      font: inherit;
      min-height: 44px;
      min-width: 220px;
      outline: none;
      padding: 10px 14px;
    }
    .monwui-serr-input:focus {
      border-color: rgba(255,183,3,0.42);
    }
    .monwui-serr-results {
      display: grid;
      gap: 14px;
      max-height: min(610px, 68vh);
      overflow: auto;
      overscroll-behavior: contain;
      padding: 18px 24px 24px;
      scrollbar-color: #ffb703 transparent;
    }
    .monwui-serr-result {
      align-items: center;
      background: linear-gradient(180deg, rgba(255,255,255,0.05), rgba(255,255,255,0.02));
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 20px;
      display: grid;
      gap: 14px;
      grid-template-columns: 68px minmax(0, 1fr) auto;
      min-width: 0;
      padding: 12px;
      transition: transform .18s ease, border-color .18s ease, box-shadow .18s ease;
    }
    .monwui-serr-result:hover,
    .monwui-serr-result:focus-within {
      border-color: rgba(255,183,3,0.42);
      box-shadow: 0 14px 30px rgba(0,0,0,0.18);
      transform: translateY(-2px);
    }
    .monwui-serr-result-actions {
      align-items: center;
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      justify-content: flex-end;
    }
    .monwui-serr-result img,
    .monwui-serr-poster-fallback {
      aspect-ratio: 2/3;
      background:
        linear-gradient(160deg, rgba(255,183,3,0.28), rgba(251,133,0,0.08)),
        rgba(255,255,255,0.06);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 16px;
      object-fit: cover;
      width: 68px;
    }
    .monwui-serr-poster-fallback {
      align-items: center;
      color: #ffb703;
      display: flex;
      font-size: 11px;
      font-weight: 800;
      justify-content: center;
      letter-spacing: .08em;
    }
    .monwui-serr-name {
      color: #fff;
      font-size: 17px;
      font-weight: 800;
      line-height: 1.22;
      overflow-wrap: anywhere;
    }
    .monwui-serr-meta,
    .monwui-serr-overview,
    .monwui-serr-state {
      color: rgba(255,255,255,0.72);
      font-size: 12px;
      line-height: 1.5;
    }
    .monwui-serr-overview {
      color: rgba(255,255,255,0.78);
      display: -webkit-box;
      font-size: 13px;
      line-height: 1.56;
      margin-top: 4px;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .monwui-serr-issues {
      display: grid;
      gap: 8px;
      margin-bottom: 16px;
    }
    .monwui-serr-issues-title {
      color: #ffb703;
      font-size: 11px;
      font-weight: 800;
      letter-spacing: 0.12em;
      text-transform: uppercase;
    }
    .monwui-serr-issue {
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.08);
      border-left: 3px solid #fb8500;
      border-radius: 12px;
      padding: 10px 12px;
    }
    .monwui-serr-issue-head {
      align-items: center;
      display: flex;
      gap: 8px;
      justify-content: space-between;
    }
    .monwui-serr-issue-type {
      color: #ffb703;
      font-size: 11px;
      font-weight: 800;
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }
    .monwui-serr-issue-status {
      color: rgba(255,255,255,0.6);
      font-size: 11px;
    }
    .monwui-serr-issue-title {
      color: rgba(255,255,255,0.92);
      font-size: 13px;
      font-weight: 700;
      margin-top: 4px;
    }
    .monwui-serr-issue-message {
      color: rgba(255,255,255,0.7);
      font-size: 12px;
      line-height: 1.5;
      margin-top: 2px;
    }
    .monwui-serr-empty,
    .monwui-serr-error,
    .monwui-serr-loading {
      background: rgba(255,255,255,0.03);
      border: 1px dashed rgba(255,255,255,0.14);
      border-radius: 18px;
      color: rgba(255,255,255,0.74);
      font-size: 14px;
      padding: 24px;
      text-align: center;
    }
    .monwui-serr-error {
      color: #fecaca;
    }
    .monwui-serr-confirm-card {
      max-width: 560px;
      width: min(560px, calc(100vw - 36px));
    }
    .monwui-serr-confirm-body {
      display: grid;
      gap: 10px;
      padding: 22px 24px 8px;
    }
    .monwui-serr-confirm-layout {
      align-items: start;
      display: grid;
      gap: 16px;
      grid-template-columns: minmax(0, 1fr);
    }
    .monwui-serr-confirm-layout.has-poster {
      grid-template-columns: 116px minmax(0, 1fr);
    }
    .monwui-serr-confirm-poster {
      align-items: center;
      aspect-ratio: 2 / 3;
      background:
        linear-gradient(160deg, rgba(255,183,3,0.28), rgba(251,133,0,0.08)),
        rgba(255,255,255,0.06);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 16px;
      box-shadow: 0 20px 40px rgba(0,0,0,0.28);
      color: #ffb703;
      display: flex;
      justify-content: center;
      overflow: hidden;
      position: relative;
      width: 116px;
    }
    .monwui-serr-confirm-poster[hidden] {
      display: none;
    }
    .monwui-serr-confirm-poster::before {
      background: linear-gradient(180deg, transparent, rgba(0,0,0,.35));
      content: "";
      inset: 0;
      position: absolute;
      z-index: 1;
    }
    .monwui-serr-confirm-poster img {
      display: block;
      height: 100%;
      inset: 0;
      object-fit: cover;
      position: absolute;
      width: 100%;
    }
    .monwui-serr-confirm-poster i {
      font-size: 32px;
      position: relative;
      z-index: 2;
    }
    .monwui-serr-confirm-summary {
      display: grid;
      gap: 10px;
      min-width: 0;
    }
    .monwui-serr-confirm-eyebrow {
      color: #ffcf70;
      font-size: 12px;
      font-weight: 800;
      letter-spacing: 0;
      text-transform: uppercase;
    }
    .monwui-serr-confirm-name {
      color: #fff;
      font-size: 22px;
      font-weight: 850;
      line-height: 1.2;
      overflow-wrap: anywhere;
    }
    .monwui-serr-confirm-meta,
    .monwui-serr-confirm-hint,
    .monwui-serr-confirm-info {
      color: rgba(255,255,255,0.76);
      font-size: 13px;
      line-height: 1.5;
    }
    .monwui-serr-confirm-info {
      background: rgba(255,183,3,0.1);
      border: 1px solid rgba(255,183,3,0.2);
      border-radius: 12px;
      color: #ffe8aa;
      margin-top: 4px;
      padding: 10px 12px;
    }
    @media (max-width: 640px) {
      #monwuiSerrModal,
      #monwuiSerrConfirmModal { padding: 10px; }
      .monwui-serr-card {
        border-radius: 18px;
        width: min(100%, calc(100vw - 20px));
      }
      .monwui-serr-head,
      .monwui-serr-searchbar,
      .monwui-serr-footer {
        padding-inline: 14px;
      }
      .monwui-serr-title {
        font-size: 22px;
      }
      .monwui-serr-result {
        grid-template-columns: 52px minmax(0, 1fr);
      }
      .monwui-serr-result .monwui-serr-result-actions {
        grid-column: 1 / -1;
        width: 100%;
      }
      .monwui-serr-result .monwui-serr-btn {
        flex: 1 1 140px;
      }
      .monwui-serr-result img,
      .monwui-serr-poster-fallback {
        border-radius: 12px;
        width: 52px;
      }
      .monwui-serr-confirm-layout.has-poster {
        gap: 12px;
        grid-template-columns: 86px minmax(0, 1fr);
      }
      .monwui-serr-confirm-poster {
        border-radius: 12px;
        width: 86px;
      }
    }
  `;
  document.head.appendChild(style);
}
