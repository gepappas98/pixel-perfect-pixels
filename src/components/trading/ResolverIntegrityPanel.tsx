import { ShieldCheck, Clock3, AlertTriangle } from "lucide-react";

export function ResolverIntegrityPanel() {
  return (
    <section className="rounded-xl border border-border bg-card p-4 sm:p-5">
      <div className="flex items-start gap-3">
        <div className="rounded-lg border border-primary/25 bg-primary/10 p-2 text-primary">
          <ShieldCheck className="h-5 w-5" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-foreground">Variant Resolver · χρονική εγκυρότητα</h2>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Η αξιολόγηση χρησιμοποιεί μόνο ολοκληρωμένα ωριαία κεριά που άνοιξαν στην ώρα εισόδου ή αργότερα.
            Το κερί που είχε ήδη ξεκινήσει πριν από το σήμα εξαιρείται, ώστε το προγενέστερο high/low να μην
            μετρήσει ως TP ή SL μετά την είσοδο.
          </p>
        </div>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div className="flex gap-2 rounded-lg border border-border bg-muted/40 p-3">
          <Clock3 className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <div>
            <p className="text-xs font-medium text-foreground">Κανόνας εισόδου</p>
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
              Δεν χρησιμοποιούνται high/low από κερί που άνοιξε πριν από το σήμα. Αυτό είναι συντηρητικό:
              μπορεί να καθυστερήσει την αναγνώριση εξόδου έως το επόμενο πλήρες ωριαίο κερί.
            </p>
          </div>
        </div>
        <div className="flex gap-2 rounded-lg border border-border bg-muted/40 p-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <div>
            <p className="text-xs font-medium text-foreground">TP και SL στο ίδιο κερί</p>
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
              Ελέγχονται με χαμηλότερα χρονικά διαστήματα. Αν δεν τεκμηριώνεται ποιο επίπεδο χτυπήθηκε πρώτο,
              το αποτέλεσμα χαρακτηρίζεται ambiguous και δεν του αποδίδεται PnL.
            </p>
          </div>
        </div>
      </div>
      <p className="mt-3 text-[10px] text-muted-foreground">
        Research-only · οι ιστορικές εγγραφές δεν τροποποιούνται αυτόματα από αυτή τη διόρθωση.
      </p>
    </section>
  );
}
