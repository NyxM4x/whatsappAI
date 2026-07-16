import { loginAction } from "@/app/admin/actions";
import { clinic } from "@/lib/clinic/config";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

  return (
    <main className="admin-login">
      <form className="admin-login-card" action={loginAction}>
        <h1>{clinic.clinicName}</h1>
        <p className="subtitle">Panel interno</p>

        {error === "rate_limited" && (
          <p className="error">Demasiados intentos fallidos. Espere unos minutos e intente de nuevo.</p>
        )}
        {error === "1" && <p className="error">Correo o contraseña incorrectos.</p>}

        <label>
          Correo
          <input type="email" name="email" required autoFocus />
        </label>
        <label>
          Contraseña
          <input type="password" name="password" required />
        </label>

        <button type="submit">Ingresar</button>
      </form>
    </main>
  );
}
