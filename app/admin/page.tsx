import Link from "next/link";
import { requireStaff } from "@/lib/admin/auth";
import {
  listAppointmentsForAdmin,
  listPaymentProofsForAdmin,
  ADMIN_PAGE_SIZE,
  type AdminAppointmentFilter,
} from "@/lib/clinic/data";
import { getClinicConfig } from "@/lib/clinic/config";
import { isHolidayToday } from "@/lib/clinic/pricing";
import {
  cancelAppointmentAction,
  confirmAppointmentAction,
  updateAppointmentDetailsAction,
  logoutAction,
  toggleHolidayAction,
  markPaymentReviewedAction,
} from "./actions";
import LeadsBoard from "./LeadsBoard";

type Tab = "solicitudes" | "pagos" | "citas";

const TABS: { value: Tab; label: string }[] = [
  { value: "solicitudes", label: "🔔 Solicitudes" },
  { value: "pagos", label: "💳 Pagos" },
  { value: "citas", label: "📅 Citas (sistema anterior)" },
];

const FILTERS: { value: AdminAppointmentFilter; label: string }[] = [
  { value: "all", label: "Todas" },
  { value: "confirmed", label: "Confirmadas" },
  { value: "pending", label: "Pendiente pago" },
  { value: "flagged", label: "⚠️ Revisar" },
  { value: "canceled", label: "Canceladas" },
];

const STATUS_LABEL: Record<string, string> = {
  draft: "Borrador",
  hold: "Reservado",
  awaiting_payment: "Esperando pago",
  payment_review: "Revisar pago",
  confirmed: "Confirmada",
  canceled: "Cancelada",
};

function formatDate(iso: string | null, timezone: string): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("es-BO", {
    timeZone: timezone,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

// Arma un href a /admin conservando pestaña, filtro, búsqueda y página según lo
// que se pase (para que paginar no pierda el filtro ni la búsqueda, y viceversa).
function adminHref(params: { tab?: Tab; filter?: string; q?: string; page?: number }): string {
  const sp = new URLSearchParams();
  if (params.tab && params.tab !== "solicitudes") sp.set("tab", params.tab);
  if (params.filter && params.filter !== "all") sp.set("filter", params.filter);
  if (params.q) sp.set("q", params.q);
  if (params.page && params.page > 1) sp.set("page", String(params.page));
  const qs = sp.toString();
  return qs ? `/admin?${qs}` : "/admin";
}

function Pagination({ total, page, hrefFor }: { total: number; page: number; hrefFor: (page: number) => string }) {
  const totalPages = Math.max(1, Math.ceil(total / ADMIN_PAGE_SIZE));
  const rangeFrom = total === 0 ? 0 : (page - 1) * ADMIN_PAGE_SIZE + 1;
  const rangeTo = Math.min(page * ADMIN_PAGE_SIZE, total);

  return (
    <nav className="admin-pagination">
      <span className="admin-pagination-info">
        {total === 0 ? "Sin resultados" : `${rangeFrom}–${rangeTo} de ${total}`}
      </span>
      <div className="admin-pagination-controls">
        {page > 1 ? <Link href={hrefFor(page - 1)}>← Anterior</Link> : <span className="disabled">← Anterior</span>}
        <span className="admin-pagination-page">Página {page} de {totalPages}</span>
        {page < totalPages ? <Link href={hrefFor(page + 1)}>Siguiente →</Link> : <span className="disabled">Siguiente →</span>}
      </div>
    </nav>
  );
}

export default async function AdminDashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; filter?: string; q?: string; page?: string }>;
}) {
  const staff = await requireStaff();
  // La clínica de la que este staff es dueño de datos — nunca la default.
  const clinic = await getClinicConfig(staff.business);
  const { tab, filter, q, page } = await searchParams;

  const activeTab: Tab = TABS.some((t) => t.value === tab) ? (tab as Tab) : "solicitudes";
  const currentPage = Math.max(1, Number(page) || 1);
  const holidayToday = isHolidayToday(clinic.holidayDate, clinic.timezone);

  return (
    <main className="admin-dashboard">
      <header className="admin-header">
        <div>
          <h1>{clinic.clinicName}</h1>
          <p>Panel interno — {staff.name}</p>
        </div>
        <div className="admin-header-actions">
          <form action={toggleHolidayAction}>
            <input type="hidden" name="enable" value={holidayToday ? "0" : "1"} />
            <button
              type="submit"
              className={holidayToday ? "btn-holiday active" : "btn-holiday"}
              title="Mientras esté activo, el bot no da precios de hoy. Se desactiva solo a medianoche."
            >
              {holidayToday ? "📅 Hoy es feriado — quitar" : "📅 Marcar hoy como feriado"}
            </button>
          </form>
          <form action={logoutAction}>
            <button type="submit" className="btn-secondary">Cerrar sesión</button>
          </form>
        </div>
      </header>

      {holidayToday && (
        <p className="holiday-banner">
          Hoy está marcado como <strong>feriado</strong>: el bot no da precios y avisa que cambian. Se desactiva solo a medianoche.
        </p>
      )}

      <nav className="admin-tabs">
        {TABS.map((t) => (
          <Link key={t.value} href={adminHref({ tab: t.value })} className={t.value === activeTab ? "active" : ""}>
            {t.label}
          </Link>
        ))}
      </nav>

      {/* La alarma vive en todas las pestañas; fuera de Solicitudes se muestra compacta. */}
      <LeadsBoard timezone={clinic.timezone} compact={activeTab !== "solicitudes"} />

      {activeTab === "pagos" && (
        <PaymentsSection business={staff.business} timezone={clinic.timezone} page={currentPage} />
      )}
      {activeTab === "citas" && (
        <AppointmentsSection
          business={staff.business}
          timezone={clinic.timezone}
          filter={filter}
          q={q}
          page={currentPage}
        />
      )}
    </main>
  );
}

async function PaymentsSection({ business, timezone, page }: { business: string; timezone: string; page: number }) {
  const { rows, total } = await listPaymentProofsForAdmin(business, page);

  return (
    <section>
      <p className="admin-section-hint">
        Comprobantes y archivos de pago que llegaron por WhatsApp, también con el bot en pausa.
      </p>
      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Recibido</th>
              <th>Contacto</th>
              <th>Teléfono</th>
              <th>Monto leído</th>
              <th>Nota</th>
              <th>Archivo</th>
              <th>Estado</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="empty">Todavía no llegaron comprobantes.</td>
              </tr>
            )}
            {rows.map((proof) => (
              <tr key={proof.id} className={proof.reviewed ? "" : "flagged"}>
                <td>{formatDate(proof.createdAt, timezone)}</td>
                <td>{proof.contactName ?? "—"}</td>
                <td>{proof.contactPhone}</td>
                <td>{proof.detectedAmount != null ? `${proof.detectedAmount} Bs` : "—"}</td>
                <td className="notes-cell">{proof.aiNote ?? ""}</td>
                <td>
                  <a href={`/api/admin/proof?url=${encodeURIComponent(proof.mediaUrl)}`} target="_blank" rel="noreferrer">
                    Ver
                  </a>
                </td>
                <td>
                  {proof.reviewed ? (
                    <span className="badge badge-confirmed">
                      Revisado{proof.reviewedByName ? ` · ${proof.reviewedByName}` : ""}
                    </span>
                  ) : (
                    <form action={markPaymentReviewedAction}>
                      <input type="hidden" name="id" value={proof.id} />
                      <button type="submit" className="btn-primary">Marcar revisado</button>
                    </form>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pagination total={total} page={page} hrefFor={(n) => adminHref({ tab: "pagos", page: n })} />
    </section>
  );
}

async function AppointmentsSection({
  business,
  timezone,
  filter,
  q,
  page,
}: {
  business: string;
  timezone: string;
  filter?: string;
  q?: string;
  page: number;
}) {
  const validFilters = FILTERS.map((f) => f.value);
  const activeFilter = (validFilters.includes(filter as AdminAppointmentFilter)
    ? filter
    : "all") as AdminAppointmentFilter;
  const search = (q ?? "").trim();

  const { rows: appointments, total } = await listAppointmentsForAdmin(business, {
    filter: activeFilter,
    search,
    page,
  });

  return (
    <section>
      <nav className="admin-filters">
        {FILTERS.map((f) => (
          <Link
            key={f.value}
            href={adminHref({ tab: "citas", filter: f.value, q: search })}
            className={f.value === activeFilter ? "active" : ""}
          >
            {f.label}
          </Link>
        ))}
      </nav>

      {/* Buscador (GET, sin JS de cliente): conserva pestaña y filtro, y
          resetea a la página 1 al buscar. */}
      <form className="admin-search" method="get" action="/admin">
        <input type="hidden" name="tab" value="citas" />
        {activeFilter !== "all" && <input type="hidden" name="filter" value={activeFilter} />}
        <input
          type="search"
          name="q"
          defaultValue={search}
          placeholder="Buscar por nombre, teléfono o CI…"
          aria-label="Buscar citas"
        />
        <button type="submit" className="btn-secondary">Buscar</button>
        {search && (
          <Link href={adminHref({ tab: "citas", filter: activeFilter })} className="admin-search-clear">
            Limpiar
          </Link>
        )}
      </form>

      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Paciente</th>
              <th>Teléfono</th>
              <th>Fecha</th>
              <th>Doctor</th>
              <th>Estado</th>
              <th>Nota</th>
              <th>Comprobante</th>
              <th>Acciones</th>
            </tr>
          </thead>
          <tbody>
            {appointments.length === 0 && (
              <tr>
                <td colSpan={8} className="empty">No hay citas para este filtro.</td>
              </tr>
            )}
            {appointments.map((appt) => (
              <tr key={appt.id} className={appt.notes ? "flagged" : ""}>
                <td>{appt.patientName ?? "—"}</td>
                <td>{appt.contactPhone}</td>
                <td>{formatDate(appt.scheduledStart, timezone)}</td>
                <td>{appt.doctorName ?? "—"}</td>
                <td>
                  <span className={`badge badge-${appt.status}`}>
                    {STATUS_LABEL[appt.status] ?? appt.status}
                  </span>
                </td>
                <td className="notes-cell">{appt.notes ?? ""}</td>
                <td>
                  {appt.paymentProofUrl ? (
                    <a
                      href={`/api/admin/proof?url=${encodeURIComponent(appt.paymentProofUrl)}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Ver
                    </a>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="actions-cell">
                  {appt.status !== "canceled" && (
                    /* Cancelar: fila expandible con <details> (sin JS de
                       cliente) para escribir el motivo, que se guarda y se le
                       avisa al paciente por WhatsApp. */
                    <details className="admin-edit">
                      <summary className="btn-danger">Cancelar</summary>
                      <form action={cancelAppointmentAction} className="admin-edit-form">
                        <input type="hidden" name="id" value={appt.id} />
                        <label>
                          Motivo (se le enviará al paciente)
                          <textarea name="reason" rows={2} required />
                        </label>
                        <button type="submit" className="btn-danger">Confirmar cancelación</button>
                      </form>
                    </details>
                  )}
                  {appt.notes && appt.status !== "confirmed" && (
                    <form action={confirmAppointmentAction}>
                      <input type="hidden" name="id" value={appt.id} />
                      <button type="submit" className="btn-primary">Confirmar</button>
                    </form>
                  )}
                  {/* Editar datos del paciente: fila expandible con <details>,
                      sin JS de cliente. Vacío = no cambia ese campo. */}
                  <details className="admin-edit">
                    <summary className="btn-secondary">Editar</summary>
                    <form action={updateAppointmentDetailsAction} className="admin-edit-form">
                      <input type="hidden" name="id" value={appt.id} />
                      <label>
                        Nombre
                        <input type="text" name="patientName" defaultValue={appt.patientName ?? ""} />
                      </label>
                      <label>
                        CI
                        <input type="text" name="patientCi" defaultValue={appt.patientCi ?? ""} />
                      </label>
                      <label>
                        Motivo
                        <input type="text" name="reason" defaultValue={appt.reason ?? ""} />
                      </label>
                      <button type="submit" className="btn-primary">Guardar</button>
                    </form>
                  </details>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Pagination
        total={total}
        page={page}
        hrefFor={(n) => adminHref({ tab: "citas", filter: activeFilter, q: search, page: n })}
      />
    </section>
  );
}
