import Link from "next/link";
import { requireStaff } from "@/lib/admin/auth";
import { listAppointmentsForAdmin, type AdminAppointmentFilter } from "@/lib/clinic/data";
import { getClinicConfig } from "@/lib/clinic/config";
import { cancelAppointmentAction, confirmAppointmentAction, logoutAction } from "./actions";

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

export default async function AdminDashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string }>;
}) {
  const staff = await requireStaff();
  const clinic = await getClinicConfig();
  const { filter } = await searchParams;
  const validFilters = FILTERS.map((f) => f.value);
  const activeFilter = (validFilters.includes(filter as AdminAppointmentFilter)
    ? filter
    : "all") as AdminAppointmentFilter;

  const appointments = await listAppointmentsForAdmin(clinic.slug, activeFilter);

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
            href={`/admin?filter=${f.value}`}
            className={f.value === activeFilter ? "active" : ""}
          >
            {f.label}
          </Link>
        ))}
      </nav>

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
                    <form action={cancelAppointmentAction}>
                      <input type="hidden" name="id" value={appt.id} />
                      <button type="submit" className="btn-danger">Cancelar</button>
                    </form>
                  )}
                  {appt.notes && appt.status !== "confirmed" && (
                    <form action={confirmAppointmentAction}>
                      <input type="hidden" name="id" value={appt.id} />
                      <button type="submit" className="btn-primary">Confirmar</button>
                    </form>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
