import { useState, useEffect } from "react";
import { useQuery, useMutation, useAction, usePaginatedQuery, useConvex } from "convex/react";
import { api } from "../../convex/_generated/api";
import { useSeason } from "../contexts/SeasonContext";
import { ArrowUpRight, ArrowDownRight, Wallet, Filter, Search, Plus, Edit2, Trash2, ExternalLink, Mail, Download } from "lucide-react";
import TransactionFormModal from "../components/TransactionFormModal";
import BudgetTrendsModal from "../components/BudgetTrendsModal";
import { getPastelColor } from "../utils/colors";
import type { Id } from "../../convex/_generated/dataModel";

type TransactionRecord = {
  _id: Id<"transactions">;
  _creationTime: number;
  date: string;
  nom: string;
  realise: number;
  typeDocument?: string;
  typeDocumentId?: Id<"typesDocuments">;
  typeDocumentNom?: string;
  commentaires?: string;
  lienDrive?: string;
  tiersId: Id<"tiers">;
  tiersNom: string;
  analytiqueId: Id<"analytiques">;
  analytiqueNom: string;
  saison: string;
};

type PaginatedExport = {
  page: TransactionRecord[];
  isDone: boolean;
  continueCursor: string;
};

export default function Compta() {
  const { season } = useSeason();
  const convex = useConvex();
  
  // États pour les filtres
  const [filterTiers, setFilterTiers] = useState<string>("Tous");
  const [filterAnalytique, setFilterAnalytique] = useState<string>("Tous");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState<string>("");
  const [isExporting, setIsExporting] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearchQuery(searchQuery);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  // Requête des statistiques serveur (totaux recalculés selon les filtres)
  const statsQuery = useQuery(api.transactions.getStats, {
    saison: season,
    filterTiersId: filterTiers,
    filterAnalytiqueId: filterAnalytique,
    searchQuery: debouncedSearchQuery,
  });
  
  // Requête paginée avec filtres délégués au backend
  const { results: transactions, status, loadMore } = usePaginatedQuery(
    api.transactions.get, 
    { 
      saison: season,
      filterTiersId: filterTiers,
      filterAnalytiqueId: filterAnalytique,
      searchQuery: debouncedSearchQuery
    },
    { initialNumItems: 50 }
  );

  const deleteTransaction = useMutation(api.transactions.remove);
  const updateTransaction = useMutation(api.transactions.update);
  const processDrive = useAction(api.drive.processTransactionDrive);

  // États pour le chargement de Drive
  const [isProcessingDrive, setIsProcessingDrive] = useState<Id<"transactions"> | null>(null);

  // États pour la modale
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isTrendsModalOpen, setIsTrendsModalOpen] = useState(false);
  const [transactionToEdit, setTransactionToEdit] = useState<TransactionRecord | null>(null);

  // Listes uniques pour les menus déroulants depuis le serveur
  const uniqueTiers = statsQuery?.uniqueTiers || [];
  const uniqueAnalytiques = statsQuery?.uniqueAnalytiques || [];

  // Un filtre ou une recherche est actif : on garde la barre de filtres visible
  // même si la recherche ne renvoie aucun résultat.
  const hasActiveFilters =
    filterTiers !== "Tous" ||
    filterAnalytique !== "Tous" ||
    debouncedSearchQuery.trim() !== "";

  // Fonction pour formater les dates proprement
  const formatDate = (dateStr: string) => {
    try {
      const date = new Date(dateStr);
      if (isNaN(date.getTime())) return dateStr;
      return date.toLocaleDateString("fr-FR", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
      });
    } catch {
      return dateStr;
    }
  };

  // Statistiques KPI calculées côté serveur sur les transactions filtrées
  const stats = statsQuery?.stats || { recettes: 0, depenses: 0, soldeNet: 0 };
  const soldeNet = stats.soldeNet;

  const handleEdit = (transaction: TransactionRecord) => {
    setTransactionToEdit(transaction);
    setIsModalOpen(true);
  };

  const handleDelete = async (id: Id<"transactions">) => {
    if (window.confirm("Êtes-vous sûr de vouloir supprimer cette transaction ?")) {
      await deleteTransaction({ id });
    }
  };

  const openNewModal = () => {
    setTransactionToEdit(null);
    setIsModalOpen(true);
  };

  const handleRenommer = async (t: TransactionRecord) => {
    const dateObj = new Date(t.date);
    const dateStr = !isNaN(dateObj.getTime()) ? dateObj.toISOString().slice(2, 10) : t.date;
    const anaNamePart = t.analytiqueNom.substring(0, 5);
    const typePart = (t.typeDocumentNom || t.typeDocument || "").replaceAll(" ", "_");
    const tiersPart = t.tiersNom.replaceAll(" ", "_");
    const comPart = (t.commentaires || "").trim().replaceAll(" ", "_");
    const generatedNom = `${anaNamePart}_${dateStr}_${typePart}_${tiersPart}_${comPart}`;
    
    try {
      await updateTransaction({ id: t._id, nom: generatedNom });
    } catch(err) {
      console.error(err);
      alert("Erreur lors du renommage");
    }
  };

  const handleProcessDrive = async (t: TransactionRecord) => {
    setIsProcessingDrive(t._id);
    
    // Formater la saison "2026-27" en "2026-2027"
    const formattedSeason = season.includes("-") && season.split("-")[1].length === 2 
      ? season.split("-")[0] + "-20" + season.split("-")[1] 
      : season;

    try {
      await processDrive({
        transactionId: t._id,
        saisonDirName: formattedSeason,
        analytiqueNom: t.analytiqueNom,
        date: t.date,
        typeDocumentNom: t.typeDocumentNom || t.typeDocument || "",
        tiersNom: t.tiersNom,
        commentaires: t.commentaires,
      });
    } catch (error) {
      console.error(error);
      alert("Erreur lors de la création du lien Drive.");
    } finally {
      setIsProcessingDrive(null);
    }
  };

  const getMailtoLink = (t: TransactionRecord) => {
    const subject = encodeURIComponent(`${t.typeDocumentNom || t.typeDocument || ''} de ${t.tiersNom || ''}`);
    const montant = Math.abs(t.realise || 0).toFixed(2).replace('.', ',');
    const body = encodeURIComponent(`Salut Isa,\n\nEn pièce jointe la ${t.typeDocumentNom || t.typeDocument || ''} de ${t.tiersNom || ''}. \n\nPour un montant de ${montant} €.\n\nBonne réception\nJeanFi`);
    // L'URL force l'utilisation du compte escalade@... et pré-remplit le destinataire compta@...
    return `https://mail.google.com/mail/u/escalade@caflarochebonneville.fr/?view=cm&fs=1&to=compta@caflarochebonneville.fr&su=${subject}&body=${body}`;
  };

  const handleExportCSV = async () => {
    if (isExporting) return;

    setIsExporting(true);
    try {
      const data: TransactionRecord[] = [];
      const seenCursors = new Set<string>();
      let cursor: string | null = null;
      let isDone = false;

      while (!isDone) {
        const response: PaginatedExport = await convex.query(api.transactions.getExportPage, {
          saison: season,
          filterTiersId: filterTiers,
          filterAnalytiqueId: filterAnalytique,
          searchQuery: debouncedSearchQuery,
          paginationOpts: { cursor, numItems: 250 },
        });

        data.push(...response.page);
        isDone = response.isDone;

        if (!isDone) {
          const nextCursor = response.continueCursor;
          if (!nextCursor || seenCursors.has(nextCursor)) {
            throw new Error("Pagination d'export invalide");
          }
          seenCursors.add(nextCursor);
          cursor = nextCursor;
        }
      }

      if (data.length === 0) {
        alert("Aucune donnée à exporter.");
        return;
      }

      // Convertir data en CSV
      const headers = ["Date", "Nom", "Type de Document", "Montant", "Tiers", "Analytique", "Commentaires"];
      const rows = data.map(t => [
        formatDate(t.date),
        t.nom,
        t.typeDocumentNom || t.typeDocument || "",
        t.realise.toString().replace(".", ","),
        t.tiersNom,
        t.analytiqueNom,
        t.commentaires || ""
      ]);

      const csvContent = [
        headers.join(";"),
        ...rows.map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(";"))
      ].join("\n");

      // Ajouter le BOM pour Excel (UTF-8)
      const blob = new Blob(["\uFEFF" + csvContent], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.setAttribute("download", `export_compta_${season}.csv`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

    } catch (error) {
      console.error("Erreur lors de l'export CSV", error);
      alert("Erreur lors de l'export CSV");
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div className="compta-page fade-in">
      <header className="page-header flex-header" style={{ justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "1rem" }}>
        <div>
          <h1>Comptabilité</h1>
          <p className="subtitle">Saison : {season}</p>
        </div>
        <div className="header-actions" style={{ display: "flex", flexDirection: "column", gap: "0.75rem", alignItems: "flex-end", flex: "1 1 300px" }}>
          <div style={{ display: "flex", gap: "0.5rem", width: "100%", justifyContent: "flex-end", flexWrap: "wrap" }}>
            <button className="btn-secondary" style={{ flex: 1, minWidth: "180px", fontSize: "0.9rem", padding: "0.75rem 1rem" }} onClick={() => setIsTrendsModalOpen(true)}>
              Tendances du Budget
            </button>
          </div>
          <button className="btn-primary" style={{ width: "100%", justifyContent: "center" }} onClick={openNewModal}>
            <Plus size={20} style={{ display: "inline-block", marginRight: "0.5rem", verticalAlign: "middle" }} />
            Nouvelle Transaction
          </button>
        </div>
      </header>

      {transactions !== undefined && (transactions.length > 0 || hasActiveFilters) && (
        <div className="filter-bar fade-in" style={{ marginBottom: "2rem" }}>
          <div className="filter-group">
            <Filter size={18} color="#000" />
            <span className="filter-label" style={{ marginRight: "1rem" }}>Filtres :</span>
          </div>
          <div className="filter-group">
            <label htmlFor="filter-ana" className="filter-label">Analytique</label>
            <select
              id="filter-ana"
              className="filter-dropdown"
              value={filterAnalytique}
              onChange={(e) => setFilterAnalytique(e.target.value)}
            >
              <option value="Tous">Tous</option>
              {uniqueAnalytiques.map(a => <option key={a.id} value={a.id}>{a.nom}</option>)}
            </select>
          </div>
          <div className="filter-group">
            <label htmlFor="filter-tiers" className="filter-label">Tiers</label>
            <select
              id="filter-tiers"
              className="filter-dropdown"
              value={filterTiers}
              onChange={(e) => setFilterTiers(e.target.value)}
            >
              <option value="Tous">Tous</option>
              {uniqueTiers.map(t => <option key={t.id} value={t.id}>{t.nom}</option>)}
            </select>
          </div>
          <div className="filter-group" style={{ marginLeft: "auto" }}>
            <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
              <input
                id="filter-search"
                type="text"
                className="filter-input"
                placeholder="Titre, commentaire..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                style={{ paddingLeft: "2.5rem" }}
              />
              <Search size={16} color="#555" style={{ position: "absolute", left: "0.75rem" }} />
            </div>
          </div>
          <div className="filter-group">
            <button
              className="btn-secondary"
              style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.9rem", padding: "0.5rem 1rem" }}
              onClick={handleExportCSV}
              disabled={isExporting}
            >
              <Download size={16} />
              {isExporting ? "Export en cours..." : "Exporter CSV"}
            </button>
          </div>
        </div>
      )}

      {transactions !== undefined && transactions.length > 0 && (
        <div className="tiles-grid mt-6" style={{ marginBottom: "2rem", marginTop: 0 }}>
          <div className="tile-card bg-success" style={{ padding: "1.5rem" }}>
            <div className="tile-icon-wrapper" style={{ width: "50px", height: "50px", marginBottom: "1rem" }}>
              <ArrowUpRight size={24} color="#000" />
            </div>
            <div className="tile-content">
              <p className="text-sm tracking-widest text-gray-500 uppercase" style={{ fontSize: "0.8rem", color: "#000" }}>Total Recettes</p>
              <h3 className="font-mono mt-2" style={{ fontSize: "1.6rem" }}>
                {stats.recettes.toLocaleString("fr-FR", { style: "currency", currency: "EUR" })}
              </h3>
            </div>
          </div>

          <div className="tile-card bg-primary" style={{ padding: "1.5rem" }}>
            <div className="tile-icon-wrapper" style={{ width: "50px", height: "50px", marginBottom: "1rem" }}>
              <ArrowDownRight size={24} color="#000" />
            </div>
            <div className="tile-content">
              <p className="text-sm tracking-widest text-gray-500 uppercase" style={{ fontSize: "0.8rem", color: "#000" }}>Total Dépenses</p>
              <h3 className="font-mono mt-2" style={{ fontSize: "1.6rem" }}>
                {stats.depenses.toLocaleString("fr-FR", { style: "currency", currency: "EUR" })}
              </h3>
            </div>
          </div>

          <div className={`tile-card ${soldeNet >= 0 ? "bg-info" : "bg-warning"}`} style={{ padding: "1.5rem" }}>
            <div className="tile-icon-wrapper" style={{ width: "50px", height: "50px", marginBottom: "1rem" }}>
              <Wallet size={24} color="#000" />
            </div>
            <div className="tile-content">
              <p className="text-sm tracking-widest text-gray-500 uppercase" style={{ fontSize: "0.8rem", color: "#000" }}>Solde Net</p>
              <h3 className="font-mono mt-2" style={{ fontSize: "1.6rem" }}>
                {soldeNet.toLocaleString("fr-FR", { style: "currency", currency: "EUR" })}
              </h3>
            </div>
          </div>
        </div>
      )}

      <section className="card glass-card mt-6" style={{ marginTop: 0 }}>
        <h2>Journal des transactions</h2>
        
        {transactions === undefined ? (
          <div className="loading">Chargement des données depuis Convex...</div>
        ) : transactions?.length === 0 ? (
          <div className="empty-state">
            <p>Aucune transaction ne correspond à ces filtres.</p>
          </div>
        ) : (
          <div className="transactions-list">
            {transactions?.map((t: TransactionRecord) => {
              const isDepense = t.realise < 0;
              return (
                <div key={t._id} className="transaction-card">
                  <div className="tc-header">
                    <div className="tc-header-main">
                      <div className="tc-date">{formatDate(t.date)}</div>
                      <div className="tc-title">{t.nom}</div>
                      <div className="tc-type">{t.typeDocumentNom || t.typeDocument}</div>
                    </div>
                    <div className={`tc-amount ${isDepense ? 'depense' : 'recette'}`}>
                      {isDepense ? "- " : "+ "}
                      {Math.abs(t.realise).toLocaleString("fr-FR", { style: "currency", currency: "EUR" })}
                    </div>
                  </div>
                  <div className="tc-badges">
                    <span className="badge facture" style={{ backgroundColor: getPastelColor(t.analytiqueNom), boxShadow: "2px 2px 0px 0px #000", color: "#1a1a1a", border: "1px solid #1a1a1a" }}>
                      {t.analytiqueNom}
                    </span>
                    <span className="badge" style={{ backgroundColor: "#fff", boxShadow: "2px 2px 0px 0px #000" }}>
                      {t.tiersNom}
                    </span>
                  </div>
                  {t.commentaires && (
                    <div className="tc-comment">
                      {t.commentaires}
                    </div>
                  )}
                  {t.lienDrive && (
                    <div className="tc-link" style={{ marginTop: "0.5rem" }}>
                      <a href={t.lienDrive} target="_blank" rel="noopener noreferrer" style={{ display: "inline-flex", alignItems: "center", gap: "0.25rem", color: "#2563eb", textDecoration: "none", fontSize: "0.85rem" }}>
                        <ExternalLink size={14} /> Voir le justificatif
                      </a>
                    </div>
                  )}
                  <div className="tc-actions" style={{ flexWrap: "wrap", gap: "0.5rem" }}>
                    <button 
                      className="btn-secondary" 
                      onClick={() => handleRenommer(t)} 
                      style={{ fontSize: "0.75rem", padding: "0.25rem 0.5rem" }}
                    >
                      Renommer
                    </button>
                    <button 
                      className="btn-secondary info" 
                      onClick={() => handleProcessDrive(t)} 
                      disabled={isProcessingDrive === t._id}
                      style={{ fontSize: "0.75rem", padding: "0.25rem 0.5rem", opacity: isProcessingDrive === t._id ? 0.5 : 1 }}
                    >
                      {isProcessingDrive === t._id ? "⏳ En cours..." : "Créer lien GDrive"}
                    </button>
                    <a 
                      href={getMailtoLink(t)} 
                      target="_blank" 
                      rel="noopener noreferrer"
                      className="btn-secondary" 
                      style={{ fontSize: "0.75rem", padding: "0.25rem 0.5rem", display: "inline-flex", alignItems: "center", gap: "0.25rem", textDecoration: "none", backgroundColor: "#eef2ff", color: "#4f46e5", borderColor: "#c7d2fe" }}
                    >
                      <Mail size={14} /> Préparer le mail
                    </a>
                    <button className="btn-icon" onClick={() => handleEdit(t)} title="Modifier" aria-label="Modifier">
                      <Edit2 size={16} />
                    </button>
                    <button className="btn-icon danger" onClick={() => handleDelete(t._id)} title="Supprimer" aria-label="Supprimer">
                      <Trash2 size={16} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {status === "CanLoadMore" && (
          <div style={{ textAlign: "center", marginTop: "1.5rem" }}>
            <button className="btn-secondary" onClick={() => loadMore(50)}>
              Charger plus de transactions
            </button>
          </div>
        )}
      </section>

      {isModalOpen && (
        <TransactionFormModal 
          key={transactionToEdit?._id || "new"}
          isOpen={isModalOpen} 
          onClose={() => setIsModalOpen(false)} 
          transactionToEdit={transactionToEdit} 
        />
      )}

      <BudgetTrendsModal
        isOpen={isTrendsModalOpen}
        onClose={() => setIsTrendsModalOpen(false)}
      />
    </div>
  );
}
