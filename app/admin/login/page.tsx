import { loginAction } from "@/app/admin/actions";

// Pantalla compartida por todas las clínicas (multi-tenant): antes de
// iniciar sesión no se sabe a qué clínica pertenece la persona, así que no
// muestra el nombre de ninguna en particular — eso aparece recién en el
// dashboard, una vez resuelta la sesión.
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

  return (
    <main className="admin-login">
      <form className="admin-login-card" action={loginAction}>
        <h1>Panel interno</h1>
        <p className="subtitle">Ingresá con tu correo y contraseña</p>

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
