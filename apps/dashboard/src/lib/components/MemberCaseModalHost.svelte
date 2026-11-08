<script lang="ts">
  /** Fiche membre partagée par les pages qui ouvrent un pseudo via `memberCaseModal`. */
  import MemberCaseModal from './MemberCaseModal.svelte';
  import { memberCaseModal } from '../stores/memberCaseModal.svelte';
</script>

<MemberCaseModal
  open={memberCaseModal.open}
  userId={memberCaseModal.userId}
  userName={memberCaseModal.userName}
  caseData={memberCaseModal.caseData}
  loading={memberCaseModal.loading}
  error={memberCaseModal.error}
  onClose={() => memberCaseModal.close()}
  onSelectUser={(userId) => memberCaseModal.showFromGraph(userId)}
/>
