"use client";

// ============================================================================
// Solicitudes con alarma — panel interno
// ----------------------------------------------------------------------------
// Consulta /api/admin/leads cada 5 s. Mientras haya solicitudes pendientes
// suena una alarma en bucle, que sigue sonando con la ventana minimizada. Cada
// solicitud se calla solo con su propio botón "Atender" (no hay apagado global,
// a pedido de la clínica), que además abre el chat en WhatsApp Web.
//
// Límites del navegador y cómo se cubren:
//   - Autoplay: el sonido solo arranca después de una interacción con la
//     página. Si está bloqueado se muestra una franja roja para activarlo con
//     un clic (o se permite el sonido del sitio en el navegador de recepción).
//   - Segundo plano: los timers de una pestaña oculta se frenan a 1 por minuto.
//     El sondeo corre en un Web Worker, que no sufre ese recorte, y el sonido es
//     un buffer en bucle del motor de audio, sin timers.
// ============================================================================

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

type LeadDTO = {
  id: string;
  kind: string;
  status: string;
  contactPhone: string;
  contactName: string | null;
  patientName: string | null;
  specialty: string | null;
  specialtyUnverified: boolean;
  doctorPreference: string | null;
  preferredTime: string | null;
  visitType: string | null;
  paymentIntention: string | null;
  serviceName: string | null;
  priceQuote: string | null;
  lastMessage: string | null;
  attendedByName: string | null;
  attendedAt: string | null;
  createdAt: string;
  updatedAt: string;
  waUrl: string | null;
  botPaused: boolean;
};

const POLL_MS = 5000;
// Nombre fijo: cada "Atender" reutiliza la misma pestaña de WhatsApp Web.
const WHATSAPP_WINDOW = "clinica-whatsapp";

const KIND_LABEL: Record<string, string> = {
  ficha: "🩺 Ficha",
  servicio: "🧾 Servicio",
  humano: "🙋 Pide hablar con una persona",
  fallidos: "⚠️ El bot no pudo ayudarle",
  cancelar: "❌ Pide cancelar",
  reprogramar: "🔁 Pide reprogramar",
  consulta_cita: "❓ Pregunta por su cita",
  pago: "💳 Quiere pagar",
  no_disponible: "🩺 Ficha (especialidad no catalogada)",
  accion: "🔔 Pide que se le avise o confirme algo",
};

const CLOSED_LABEL: Record<string, string> = {
  attended: "Atendida",
  withdrawn: "El paciente desistió",
};

type AlarmSound = {
  start(): void;
  stop(): void;
  unlock(): Promise<void>;
  isBlocked(): boolean;
};

function createAlarmSound(): AlarmSound | null {
  const AudioCtx = window.AudioContext ?? (window as any).webkitAudioContext;
  if (!AudioCtx) return null;
  const ctx: AudioContext = new AudioCtx();

  // Patrón de 2 s: tres pitidos y silencio, reproducido en bucle.
  const rate = ctx.sampleRate;
  const buffer = ctx.createBuffer(1, Math.floor(rate * 2), rate);
  const samples = buffer.getChannelData(0);
  const beep = (startSec: number, durationSec: number, frequency: number) => {
    const offset = Math.floor(startSec * rate);
    const length = Math.floor(durationSec * rate);
    for (let i = 0; i < length; i++) {
      const envelope = Math.min(1, i / (0.01 * rate), (length - i) / (0.02 * rate));
      samples[offset + i] = Math.sin((2 * Math.PI * frequency * i) / rate) * 0.8 * envelope;
    }
  };
  beep(0, 0.2, 880);
  beep(0.3, 0.2, 660);
  beep(0.6, 0.2, 880);

  let source: AudioBufferSourceNode | null = null;
  return {
    start() {
      if (source) return;
      source = ctx.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      source.connect(ctx.destination);
      source.start();
    },
    stop() {
      if (!source) return;
      try {
        source.stop();
      } catch {
        // ya estaba detenido
      }
      source.disconnect();
      source = null;
    },
    async unlock() {
      if (ctx.state === "running") return;
      try {
        await ctx.resume();
      } catch {
        // sigue bloqueado: la franja roja queda visible
      }
    },
    isBlocked() {
      return ctx.state !== "running";
    },
  };
}

function formatClock(iso: string | null, timezone: string): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("es-BO", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

function timeAgo(iso: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (minutes < 1) return "recién";
  if (minutes < 60) return `hace ${minutes} min`;
  return `hace ${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

function LeadDetails({ lead }: { lead: LeadDTO }) {
  const rows: [string, string | null][] = [
    ["Paciente", lead.patientName],
    ["WhatsApp", [lead.contactName, lead.contactPhone].filter(Boolean).join(" · ")],
    // specialtyUnverified: el paciente pidió una especialidad, un servicio o un
    // examen que no está en ningún catálogo nuestro. No significa que la
    // clínica no lo tenga — puede que solo no esté cargado acá (el Excel de
    // tarifario no siempre está completo) — así que se marca para que el
    // asesor lo confirme, nunca se le dice al paciente que no lo ofrecemos.
    [
      lead.specialtyUnverified ? "Pidió (a confirmar)" : "Especialidad",
      lead.specialty
        ? lead.specialtyUnverified
          ? `⚠️ ${lead.specialty} — no está en catálogo, confirmar con la clínica`
          : lead.specialty
        : null,
    ],
    ["Médico de preferencia", lead.doctorPreference],
    ["Servicio", lead.serviceName],
    ["Horario que prefiere", lead.preferredTime],
    ["Tipo", lead.visitType === "reconsulta" ? "Reconsulta" : lead.visitType === "nueva" ? "Consulta nueva" : null],
    ["Pago que anunció", lead.paymentIntention === "qr" ? "Por QR" : lead.paymentIntention === "efectivo" ? "En efectivo al llegar" : null],
    ["Precio informado", lead.priceQuote],
    ["Último mensaje", lead.lastMessage],
  ];
  return (
    <dl className="lead-details">
      {rows
        .filter(([, value]) => value)
        .map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
    </dl>
  );
}

// Botón "IA: ACTIVA / PAUSADA" por cliente (nunca global). Actúa por teléfono
// — la identidad durable — así que sigue funcionando aunque Kapso le abra al
// mismo paciente otra conversación técnica.
function BotPauseControl({
  phone,
  paused,
  onToggled,
}: {
  phone: string;
  paused: boolean;
  onToggled: (phone: string, paused: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);

  const toggle = async () => {
    if (busy) return;
    setBusy(true);
    const nextAction = paused ? "resume" : "pause";
    try {
      const res = await fetch("/api/admin/bot-pause", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone, action: nextAction }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { botPaused: boolean };
      onToggled(phone, data.botPaused);
    } catch {
      // Sin cambio optimista: si falló, el próximo sondeo muestra el estado real.
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      className={`btn-bot-toggle ${paused ? "bot-paused" : "bot-active"}`}
      onClick={toggle}
      disabled={busy}
      title={paused ? "La IA no le responde a este cliente. Tocar para reactivarla." : "La IA le responde a este cliente. Tocar para pausarla."}
    >
      {busy ? "…" : paused ? "🤖 IA pausada — Reactivar" : "🤖 IA activa — Pausar"}
    </button>
  );
}

export default function LeadsBoard({ timezone, compact }: { timezone: string; compact: boolean }) {
  const [pending, setPending] = useState<LeadDTO[]>([]);
  const [recent, setRecent] = useState<LeadDTO[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [soundBlocked, setSoundBlocked] = useState(false);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [offline, setOffline] = useState(false);
  const alarmRef = useRef<AlarmSound | null>(null);
  // Atendidas desde esta pantalla: un sondeo que salió antes del clic no las revive.
  const attendedRef = useRef<Set<string>>(new Set());
  const baseTitleRef = useRef("");
  // Overrides optimistas tras tocar "Pausar/Reactivar IA", por teléfono
  // normalizado — el próximo sondeo (5 s) los reemplaza por el estado real.
  const [pauseOverrides, setPauseOverrides] = useState<Record<string, boolean>>({});

  const handleBotToggled = useCallback((phone: string, paused: boolean) => {
    setPauseOverrides((current) => ({ ...current, [phone]: paused }));
  }, []);

  const withOverride = useCallback(
    (leads: LeadDTO[]) =>
      leads.map((lead) =>
        lead.contactPhone in pauseOverrides
          ? { ...lead, botPaused: pauseOverrides[lead.contactPhone] }
          : lead,
      ),
    [pauseOverrides],
  );

  const refreshSoundState = useCallback(() => {
    setSoundBlocked(alarmRef.current ? alarmRef.current.isBlocked() : false);
  }, []);

  const unlockSound = useCallback(async () => {
    await alarmRef.current?.unlock();
    refreshSoundState();
  }, [refreshSoundState]);

  const poll = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/leads", { cache: "no-store" });
      if (res.status === 401) {
        setSessionExpired(true);
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { pending: LeadDTO[]; recent: LeadDTO[] };
      setSessionExpired(false);
      setOffline(false);
      setPending(data.pending.filter((lead) => !attendedRef.current.has(lead.id)));
      setRecent(data.recent);
      setLoaded(true);
    } catch {
      setOffline(true);
    } finally {
      refreshSoundState();
    }
  }, [refreshSoundState]);

  // Audio: un solo contexto; cualquier clic o tecla en la página lo desbloquea.
  useEffect(() => {
    baseTitleRef.current = document.title;
    alarmRef.current = createAlarmSound();
    const timer = window.setTimeout(refreshSoundState, 500);
    document.addEventListener("pointerdown", unlockSound);
    document.addEventListener("keydown", unlockSound);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("pointerdown", unlockSound);
      document.removeEventListener("keydown", unlockSound);
      alarmRef.current?.stop();
    };
  }, [refreshSoundState, unlockSound]);

  // Sondeo desde un Web Worker (no se frena con la pestaña en segundo plano).
  useEffect(() => {
    poll();
    let worker: Worker | null = null;
    let workerUrl: string | null = null;
    let interval: number | null = null;
    try {
      workerUrl = URL.createObjectURL(
        new Blob([`setInterval(function () { postMessage(0); }, ${POLL_MS});`], { type: "text/javascript" }),
      );
      worker = new Worker(workerUrl);
      worker.onmessage = () => {
        poll();
      };
    } catch {
      interval = window.setInterval(poll, POLL_MS);
    }
    return () => {
      worker?.terminate();
      if (workerUrl) URL.revokeObjectURL(workerUrl);
      if (interval !== null) window.clearInterval(interval);
    };
  }, [poll]);

  useEffect(() => {
    if (pending.length > 0) alarmRef.current?.start();
    else alarmRef.current?.stop();
  }, [pending.length]);

  // Título parpadeante: se ve en la barra de tareas con la ventana minimizada.
  useEffect(() => {
    if (!pending.length) {
      if (baseTitleRef.current) document.title = baseTitleRef.current;
      return;
    }
    let highlighted = false;
    const timer = window.setInterval(() => {
      highlighted = !highlighted;
      document.title = highlighted ? `🔔 (${pending.length}) Solicitudes pendientes` : baseTitleRef.current;
    }, 1000);
    return () => {
      window.clearInterval(timer);
      document.title = baseTitleRef.current;
    };
  }, [pending.length]);

  const attend = (lead: LeadDTO) => {
    // window.open primero y sin await: fuera del clic el navegador lo bloquea como popup.
    if (lead.waUrl) window.open(lead.waUrl, WHATSAPP_WINDOW);
    attendedRef.current.add(lead.id);
    setPending((current) => current.filter((l) => l.id !== lead.id));
    fetch(`/api/admin/leads/${lead.id}/attend`, { method: "POST" })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      })
      .catch(() => {
        // No quedó registrada: el próximo sondeo la vuelve a mostrar (y a sonar).
        attendedRef.current.delete(lead.id);
      })
      .finally(() => {
        poll();
      });
  };

  const banners = (
    <>
      {soundBlocked && (
        <button type="button" className="leads-banner leads-banner-danger" onClick={unlockSound}>
          🔇 El navegador bloqueó el sonido de las alarmas. Toque aquí para activarlo.
        </button>
      )}
      {sessionExpired && (
        <div className="leads-banner leads-banner-danger">
          ⚠️ La sesión se cerró y no llegan nuevas solicitudes. <a href="/admin/login">Volver a iniciar sesión</a>
        </div>
      )}
      {offline && !sessionExpired && (
        <div className="leads-banner leads-banner-warn">Sin conexión con el servidor. Reintentando…</div>
      )}
    </>
  );

  if (compact) {
    return (
      <div className="leads-compact-wrap">
        {banners}
        {pending.length > 0 && (
          <Link href="/admin" className="leads-compact">
            🔔 {pending.length} {pending.length === 1 ? "solicitud pendiente" : "solicitudes pendientes"} — ver y atender
          </Link>
        )}
      </div>
    );
  }

  return (
    <section className="leads">
      {banners}

      <h2 className="leads-title">
        Solicitudes pendientes {pending.length > 0 && <span className="leads-count">{pending.length}</span>}
      </h2>

      {!loaded ? (
        <p className="leads-empty">Cargando…</p>
      ) : pending.length === 0 ? (
        <p className="leads-empty">No hay solicitudes pendientes ✅</p>
      ) : (
        <div className="lead-grid">
          {withOverride(pending).map((lead) => (
            <article key={lead.id} className={`lead-card lead-kind-${lead.kind}`}>
              <header className="lead-card-header">
                <span className="lead-kind">{KIND_LABEL[lead.kind] ?? lead.kind}</span>
                <time>
                  {formatClock(lead.createdAt, timezone)} · {timeAgo(lead.createdAt)}
                </time>
              </header>
              <LeadDetails lead={lead} />
              <button type="button" className="btn-attend" onClick={() => attend(lead)}>
                ATENDER
              </button>
              <p className="lead-hint">Abre el chat en WhatsApp Web y apaga esta alarma</p>
              <BotPauseControl phone={lead.contactPhone} paused={lead.botPaused} onToggled={handleBotToggled} />
            </article>
          ))}
        </div>
      )}

      <h3 className="leads-subtitle">Cerradas recientemente</h3>
      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Llegó</th>
              <th>Motivo</th>
              <th>Paciente</th>
              <th>Teléfono</th>
              <th>Estado</th>
              <th>Chat</th>
              <th>IA</th>
            </tr>
          </thead>
          <tbody>
            {recent.length === 0 && (
              <tr>
                <td colSpan={7} className="empty">Todavía no hay solicitudes cerradas.</td>
              </tr>
            )}
            {withOverride(recent).map((lead) => (
              <tr key={lead.id}>
                <td>{formatClock(lead.createdAt, timezone)}</td>
                <td>{KIND_LABEL[lead.kind] ?? lead.kind}</td>
                <td>{lead.patientName ?? lead.contactName ?? "—"}</td>
                <td>{lead.contactPhone}</td>
                <td>
                  {CLOSED_LABEL[lead.status] ?? lead.status}
                  {lead.attendedByName ? ` · ${lead.attendedByName} (${formatClock(lead.attendedAt, timezone)})` : ""}
                </td>
                <td>
                  {lead.waUrl ? (
                    <a href={lead.waUrl} target={WHATSAPP_WINDOW} rel="noreferrer">
                      Abrir chat
                    </a>
                  ) : (
                    "—"
                  )}
                </td>
                <td>
                  <BotPauseControl phone={lead.contactPhone} paused={lead.botPaused} onToggled={handleBotToggled} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
