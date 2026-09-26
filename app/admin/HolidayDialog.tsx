"use client";

// ============================================================================
// Feriados — ventana del panel
// ----------------------------------------------------------------------------
// El botón de la cabecera abre una ventanita (sin salir del panel) para marcar
// una fecha como feriado, también por adelantado, y quitar las que ya están.
// En esos días el bot cobra la tarifa de domingo. Las fechas pasadas dejan de
// valer solas.
// ============================================================================

import { useActionState, useRef } from "react";
import { updateHolidaysAction, type HolidayActionState } from "./actions";

const INITIAL: HolidayActionState = { error: null };

// "2026-10-12" → "lunes 12 de octubre"
function formatHoliday(isoDate: string): string {
  return new Intl.DateTimeFormat("es-BO", {
    timeZone: "UTC",
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(new Date(`${isoDate}T12:00:00Z`));
}

export default function HolidayDialog({ today, holidays }: { today: string; holidays: string[] }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [state, formAction, pending] = useActionState(updateHolidaysAction, INITIAL);
  const todayIsHoliday = holidays.includes(today);

  return (
    <>
      <button
        type="button"
        className={todayIsHoliday ? "btn-holiday active" : "btn-holiday"}
        onClick={() => dialogRef.current?.showModal()}
      >
        {todayIsHoliday ? "📅 Hoy es feriado" : holidays.length ? `📅 Feriados (${holidays.length})` : "📅 Marcar feriado"}
      </button>

      <dialog ref={dialogRef} className="holiday-dialog" aria-labelledby="holiday-dialog-title">
        <div className="holiday-dialog-head">
          <h2 id="holiday-dialog-title">Feriados</h2>
          <button type="button" className="holiday-dialog-close" aria-label="Cerrar" onClick={() => dialogRef.current?.close()}>
            ✕
          </button>
        </div>
        <p className="holiday-dialog-help">
          En los días marcados el bot cobra la <strong>tarifa de domingo</strong>. Puede marcarlos con anticipación.
        </p>

        <form action={formAction} className="holiday-dialog-add">
          <input type="hidden" name="intent" value="add" />
          <label htmlFor="holiday-date">Fecha del feriado</label>
          <div className="holiday-dialog-row">
            <input id="holiday-date" type="date" name="date" min={today} defaultValue={today} required />
            <button type="submit" className="btn-primary" disabled={pending}>
              {pending ? "Guardando…" : "Marcar"}
            </button>
          </div>
        </form>

        {state.error && <p className="holiday-dialog-error">{state.error}</p>}

        <h3>Marcados</h3>
        {holidays.length ? (
          <ul className="holiday-dialog-list">
            {holidays.map((date) => (
              <li key={date}>
                <span>
                  {formatHoliday(date)}
                  {date === today && <strong> — hoy</strong>}
                </span>
                <form action={formAction}>
                  <input type="hidden" name="intent" value="remove" />
                  <input type="hidden" name="date" value={date} />
                  <button type="submit" className="btn-secondary" disabled={pending}>
                    Quitar
                  </button>
                </form>
              </li>
            ))}
          </ul>
        ) : (
          <p className="holiday-dialog-empty">No hay feriados marcados.</p>
        )}
      </dialog>
    </>
  );
}
