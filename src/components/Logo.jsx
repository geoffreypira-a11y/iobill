import React from "react";

export function LogoMark({ size = 36 }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      xmlns="http://www.w3.org/2000/svg"
      aria-label="IO BILL"
    >
      <rect width="100" height="100" rx="22" fill="#0b0c10" />
      <rect x="1.5" y="1.5" width="97" height="97" rx="20.5" fill="none" stroke="#d4a843" strokeWidth="2" />
      <rect x="26" y="28" width="10" height="44" rx="1.5" fill="#d4a843" />
      <circle cx="66" cy="50" r="18" fill="none" stroke="#d4a843" strokeWidth="10" />
    </svg>
  );
}

export function LogoFull({ size = 36 }) {
  return (
    <div className="sidebar-logo">
      <LogoMark size={size} />
      <div className="sidebar-logo-text">
        <div className="logo-main">
          IO<span>BILL</span>
        </div>
        <div className="logo-sub">Owl's Industry</div>
      </div>
    </div>
  );
}
