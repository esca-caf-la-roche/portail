import { ArrowLeft } from "lucide-react";
import { Link } from "react-router-dom";

export default function PortalReturnLink() {
  return (
    <Link to="/" className="portal-return-link">
      <ArrowLeft size={18} aria-hidden="true" />
      Retour au portail
    </Link>
  );
}
