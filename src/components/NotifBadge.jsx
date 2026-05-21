import React from "react";

/**
 * NotifBadge — v8.27.5
 * Petit rond avec compteur (style WhatsApp/Slack)
 * 
 * Usage :
 *   <NotifBadge count={3} />               → rond rouge avec "3"
 *   <NotifBadge count={3} severity="warning" />  → rond orange
 *   <NotifBadge dot />                     → simple pastille sans compteur
 */
export function NotifBadge({ count, severity = "critical", dot = false, title }) {
  if (!dot && (!count || count <= 0)) return null;

  const color = severity === "critical" ? "#e54949"
    : severity === "warning" ? "#e5973c"
    : "#5b9fff";

  const baseStyle = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    background: color,
    color: "#fff",
    borderRadius: "50%",
    fontWeight: 700,
    boxShadow: `0 0 0 2px var(--bg, #0b0c10)`,
    marginLeft: 6,
    verticalAlign: "middle",
    lineHeight: 1
  };

  if (dot) {
    return (
      <span
        title={title}
        style={{ ...baseStyle, width: 8, height: 8, fontSize: 0 }}
      />
    );
  }

  const display = count > 9 ? "9+" : String(count);
  return (
    <span
      title={title || `${count} signalement${count > 1 ? "s" : ""}`}
      style={{
        ...baseStyle,
        minWidth: 18,
        height: 18,
        padding: "0 5px",
        fontSize: 10
      }}
    >
      {display}
    </span>
  );
}
