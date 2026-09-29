"""Armado y envío de emails de alerta (smtplib)."""
import re
import smtplib
import ssl
from datetime import date
from email.message import EmailMessage
from email.utils import formataddr
from html import escape

from .config import get_settings
from .inactivity import format_dni

PLACEHOLDER_RE = re.compile(r"\{(\w+)\}")

# Placeholders disponibles para el panel.
PLACEHOLDERS = {
    "nombre": "Nombre completo del usuario",
    "dni": "Documento de identidad",
    "dias": "Días laborables sin cargar horas",
    "ultima_carga": "Fecha de la última carga",
    "grupo": "Nombre del grupo",
    "umbral": "Umbral configurado (días)",
    "cantidad": "Cantidad de personas en el email",
    "fecha": "Fecha del envío",
}


def render(template: str, ctx: dict) -> str:
    """Reemplaza {clave} por su valor; deja intactas las claves desconocidas."""
    return PLACEHOLDER_RE.sub(lambda m: str(ctx.get(m.group(1), m.group(0))), template)


def _fecha(iso: str | None) -> str:
    if not iso:
        return "sin registros"
    return date.fromisoformat(iso).strftime("%d/%m/%Y")


def user_context(u: dict, grupo: str, umbral: int) -> dict:
    dias = f"+{u['dias_inactivo']}" if u.get("dias_es_minimo") else str(u["dias_inactivo"])
    return {
        "nombre": u["nombre"],
        "dni": format_dni(u["dni"]),
        "dias": dias,
        "ultima_carga": _fecha(u["ultima_carga"]),
        "grupo": grupo,
        "umbral": umbral,
    }


def _user_card(ctx: dict, mensaje: str) -> str:
    e = {k: escape(str(v)) for k, v in ctx.items()}
    msg = escape(mensaje)
    return f"""
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"
       style="margin:0 0 16px 0;border:1px solid #f3d3c4;border-left:6px solid #d03b3b;border-radius:8px;background:#fffaf7;">
  <tr>
    <td style="padding:16px 18px;">
      <div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#9a3412;font-weight:700;">Usuario inactivo</div>
      <div style="font-size:22px;font-weight:800;color:#1f2937;margin:4px 0 8px 0;">{e['nombre']}</div>
      <span style="display:inline-block;background:#1f2937;color:#ffffff;font-size:15px;font-weight:700;padding:6px 12px;border-radius:6px;letter-spacing:.03em;">DNI {e['dni']}</span>
    </td>
    <td align="right" valign="top" style="padding:16px 18px;white-space:nowrap;">
      <div style="font-size:40px;line-height:1;font-weight:800;color:#d03b3b;">{e['dias']}</div>
      <div style="font-size:12px;color:#6b7280;font-weight:600;">días laborables<br/>sin cargar horas</div>
    </td>
  </tr>
  <tr>
    <td colspan="2" style="padding:0 18px 16px 18px;font-size:14px;color:#374151;line-height:1.5;">
      <div style="margin-bottom:6px;color:#6b7280;">Última carga: <strong style="color:#1f2937;">{e['ultima_carga']}</strong></div>
      {msg}
    </td>
  </tr>
</table>"""


def build_email(usuarios: list[dict], grupo: str, cfg, fecha: date) -> tuple[str, str, str]:
    """Devuelve (asunto, html, texto) para un envío a un grupo."""
    base_ctx = {"grupo": grupo, "umbral": cfg.umbral_dias,
                "cantidad": len(usuarios), "fecha": fecha.strftime("%d/%m/%Y")}
    ctxs = [{**base_ctx, **user_context(u, grupo, cfg.umbral_dias)} for u in usuarios]

    asunto = render(cfg.asunto, ctxs[0] if len(ctxs) == 1 else base_ctx)
    cards = "".join(_user_card(c, render(cfg.mensaje, c)) for c in ctxs)

    html = f"""<!doctype html>
<html lang="es"><body style="margin:0;padding:0;background:#f3f4f6;font-family:Segoe UI,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:24px 0;">
<tr><td align="center">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;">
    <tr><td style="background:#F26722;padding:24px 28px;">
      <div style="font-size:28px;font-weight:800;color:#ffffff;letter-spacing:.02em;">⚠ ALERTA DE INACTIVIDAD</div>
      <div style="font-size:14px;color:#ffe7da;margin-top:4px;">TimeTrack · Carga de horas · {escape(base_ctx['fecha'])}</div>
    </td></tr>
    <tr><td style="padding:24px 28px 8px 28px;font-size:15px;color:#374151;line-height:1.5;">
      Hola, las siguientes <strong>{len(usuarios)}</strong> persona(s) del grupo
      <strong>{escape(grupo)}</strong> superaron el límite de
      <strong>{cfg.umbral_dias} día(s) laborable(s)</strong> sin registrar horas:
    </td></tr>
    <tr><td style="padding:8px 28px 8px 28px;">{cards}</td></tr>
    <tr><td style="padding:8px 28px 28px 28px;font-size:12px;color:#9ca3af;border-top:1px solid #f3f4f6;">
      Mensaje automático generado por TimeTrack. Los fines de semana y feriados no se cuentan como días de inactividad.
    </td></tr>
  </table>
</td></tr></table>
</body></html>"""

    lines = [f"ALERTA DE INACTIVIDAD - {base_ctx['fecha']}", f"Grupo: {grupo}", ""]
    for c in ctxs:
        lines += [
            f"* {c['nombre']} - DNI {c['dni']}",
            f"  {c['dias']} día(s) laborable(s) sin cargar horas. Última carga: {c['ultima_carga']}",
            f"  {render(cfg.mensaje, c)}",
            "",
        ]
    return asunto, html, "\n".join(lines)


def send_email(to: list[str], subject: str, html: str, text: str) -> None:
    s = get_settings()
    if not s.smtp_configured:
        raise RuntimeError("SMTP no configurado (SMTP_HOST y SMTP_FROM o SMTP_USER en API/.env)")

    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = formataddr((s.smtp_from_name, s.smtp_sender))
    msg["To"] = ", ".join(to)
    msg.set_content(text)
    msg.add_alternative(html, subtype="html")

    security = s.smtp_security.lower()
    ctx = ssl.create_default_context()
    if security == "ssl":
        server: smtplib.SMTP = smtplib.SMTP_SSL(s.smtp_host, s.smtp_port, context=ctx, timeout=20)
    else:
        server = smtplib.SMTP(s.smtp_host, s.smtp_port, timeout=20)
    with server:
        if security == "starttls":
            server.starttls(context=ctx)
        if s.smtp_user:
            server.login(s.smtp_user, s.smtp_password)
        server.send_message(msg)
