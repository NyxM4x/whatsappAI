import Link from "next/link";
import { requireStaff } from "@/lib/admin/auth";
import {
  listAppointmentsForAdmin,
  ADMIN_PAGE_SIZE,
  type AdminAppointmentFilter,
} from "@/lib/clinic/data";
import { getClinicConfig } from "@/lib/clinic/config";
import {
  cancelAppointmentAction,
  confirmAppointmentAction,
  updateAppointmentDetailsAction,
  logoutAction,
} from "./actions";

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

// Arma un href a /admin conservando filtro, búsqueda y página según lo que se
// pase (para que paginar no pierda el filtro ni la búsqueda, y viceversa).
function adminHref(params: { filter: string; q: string; page?: number }): string {
  const sp = new URLSearchParams();
  if (params.filter && params.filter !== "all") sp.set("filter", params.filter);
  if (params.q) sp.set("q", params.q);
  if (params.page && params.page > 1) sp.set("page", String(params.page));
  const qs = sp.toString();
  return qs ? `/admin?${qs}` : "/admin";
}

export default async function AdminDashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string; q?: string; page?: string }>;
}) {
  const staff = await requireStaff();
  // La clínica de la que este staff es dueño de datos — nunca la default.
  const clinic = await getClinicConfig(staff.business);
  const { filter, q, page } = await searchParams;

  const validFilters = FILTERS.map((f) => f.value);
  const activeFilter = (validFilters.includes(filter as AdminAppointmentFilter)
    ? filter
    : "all") as AdminAppointmentFilter;
  const search = (q ?? "").trim();
  const currentPage = Math.max(1, Number(page) || 1);

  const { rows: appointments, total } = await listAppointmentsForAdmin(staff.business, {
    filter: activeFilter,
    search,
    page: currentPage,
  });

  const totalPages = Math.max(1, Math.ceil(total / ADMIN_PAGE_SIZE));
  const rangeFrom = total === 0 ? 0 : (currentPage - 1) * ADMIN_PAGE_SIZE + 1;
  const rangeTo = Math.min(currentPage * ADMIN_PAGE_SIZE, total);

  return (
    <main className="admin-dashboard">
      <header className="admin-header">
        <div>
          <h1>{clinic.clinicName}</h1>
          <p>Panel interno — {staff.name}</p>
        </div>
        <form action={logoutAction}>
          <button type="submit" className="btn-secondary">Cerrar sesión</button>
        </form>
      </header>

      <nav className="admin-filters">
        {FILTERS.map((f) => (
          <Link
            key={f.value}
            href={adminHref({ filter: f.value, q: search })}
            className={f.value === activeFilter ? "active" : ""}
          >
            {f.label}
          </Link>
        ))}
      </nav>

      {/* Buscador (GET, sin JS de cliente): conserva el filtro activo y resetea
          a la página 1 al buscar. */}
      <form className="admin-search" method="get" action="/admin">
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
          <Link href={adminHref({ filter: activeFilter, q: "" })} className="admin-search-clear">
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
                <td>{formatDate(appt.scheduledStart, clinic.timezone)}</td>
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

      <nav className="admin-pagination">
        <span className="admin-pagination-info">
          {total === 0 ? "Sin resultados" : `${rangeFrom}–${rangeTo} de ${total}`}
        </span>
        <div className="admin-pagination-controls">
          {currentPage > 1 ? (
            <Link href={adminHref({ filter: activeFilter, q: search, page: currentPage - 1 })}>
              ← Anterior
            </Link>
          ) : (
            <span className="disabled">← Anterior</span>
          )}
          <span className="admin-pagination-page">Página {currentPage} de {totalPages}</span>
          {currentPage < totalPages ? (
            <Link href={adminHref({ filter: activeFilter, q: search, page: currentPage + 1 })}>
              Siguiente →
            </Link>
          ) : (
            <span className="disabled">Siguiente →</span>
          )}
        </div>
      </nav>
    </main>
  );
}
