import { NavLink, Outlet } from "react-router-dom";

const navClass = ({ isActive }: { isActive: boolean }) =>
  `pay-nav-link${isActive ? " active" : ""}`;

export default function PaiementsLayout() {
  return (
    <div className="pay-layout">
      <nav className="pay-nav">
        <NavLink to="/paiements" end className={navClass}>
          Validation
        </NavLink>
        <NavLink to="/paiements/config" className={navClass}>
          Config
        </NavLink>
        <NavLink to="/paiements/approbations" className={navClass}>
          Approbations
        </NavLink>
        <NavLink to="/paiements/attente" className={navClass}>
          Attente
        </NavLink>
      </nav>
      <Outlet />
    </div>
  );
}
