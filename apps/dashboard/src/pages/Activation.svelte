<script lang="ts">
  import { m } from '../lib/i18n';
  import { authStore } from '../lib/stores/auth.svelte';
  import { dashboardStore } from '../lib/stores/dashboard.svelte';
  import { activateGuildWithCode } from '../lib/api';
  import { toast } from '../lib/stores/toast.svelte';
  import Papicon from '../lib/components/Papicon.svelte';

  import { errorMessage as describeError } from '@kotbo/shared';
  let code = $state('');
  let loading = $state(false);
  let errorMessage = $state<string | null>(null);

  const selectedGuild = $derived(
    authStore.guilds.find((guild) => guild.id === authStore.selectedGuildId)
  );

  const guildIconUrl = $derived(
    selectedGuild?.icon 
      ? `https://cdn.discordapp.com/icons/${selectedGuild.id}/${selectedGuild.icon}.png`
      : null
  );

  async function handleActivate() {
    if (!code.trim()) {
      errorMessage = m.ctv_please_enter_an_activation_cod();
      return;
    }

    loading = true;
    errorMessage = null;

    try {
      await activateGuildWithCode(code.trim());
      toast.success(m.ctv_server_activated_successfully());
      
      // Reset the dashboard store error and trigger a full sync/refresh
      dashboardStore.state.error = null;
      await dashboardStore.refresh();
    } catch (err) {
      console.error("Activation failed:", err);
      errorMessage = describeError(err) || m.ctv_communication_error_with_the_l();
    } finally {
      loading = false;
    }
  }

  function handleSelectGuild(guildId: string) {
    authStore.setGuild(guildId);
    dashboardStore.refresh();
  }

  const logout = () => {
    authStore.logout();
  };

  const year = new Date().getFullYear();
</script>

<div class="relative min-h-screen w-full overflow-hidden bg-[#020617] text-slate-100 selection:bg-primary/30 selection:text-white flex flex-col font-body">
  
  <!-- Background Mesh & FX -->
  <div class="absolute inset-0 z-0 overflow-hidden pointer-events-none">
    <div class="absolute -top-[10%] -left-[10%] w-[50%] h-[50%] bg-primary/20 rounded-full blur-[120px] opacity-50"></div>
    <div class="absolute top-[20%] -right-[10%] w-[40%] h-[40%] bg-blue-600/10 rounded-full blur-[100px] opacity-30" style="animation-delay: -5s"></div>
    <div class="absolute -bottom-[10%] left-[20%] w-[45%] h-[45%] bg-indigo-500/15 rounded-full blur-[110px] opacity-40" style="animation-delay: -10s"></div>
    
    <!-- Pattern Overlay -->
    <div class="absolute inset-0 opacity-[0.03]" style="background-image: radial-gradient(#fff 1px, transparent 1px); background-size: 40px 40px;"></div>
    <div class="absolute inset-0 bg-gradient-to-b from-transparent via-[#020617]/50 to-[#020617]"></div>
  </div>

  <!-- Header -->
  <header class="relative z-20 w-full px-8 py-8 max-w-7xl mx-auto">
    <nav class="flex justify-between items-center">
      <div class="flex items-center gap-4">
        <div class="w-10 h-10 bg-primary/10 rounded-xl flex items-center justify-center border border-primary/20">
          <img src="/favicon.svg" alt="Kotbo" class="w-6 h-6" />
        </div>
        <span class="text-xl font-semibold tracking-tighter font-headline uppercase text-white/90">
          Kotbo<span class="text-primary">.io</span>
        </span>
      </div>
      
      <div class="flex items-center gap-4">
        {#if authStore.user}
          <div class="flex items-center gap-3 bg-white/5 border border-white/10 px-4 py-2 rounded-lg">
            <span class="text-xs font-bold text-slate-300">{authStore.user.username}</span>
            <button onclick={logout} class="text-xs font-semibold text-rose-500 hover:underline">{m.ctv_disconnect()}</button>
          </div>
        {/if}
      </div>
    </nav>
  </header>

  <!-- Main Content -->
  <main class="relative z-10 flex-grow flex items-center justify-center px-6 py-12">
    <div class="w-full max-w-[580px] animate-in fade-in slide-in-from-bottom-8 duration-1000">
      
      <!-- Premium Glass Card -->
      <div class="relative group">
        <!-- Glow effect -->
        <div class="absolute -inset-1 bg-linear-to-r from-primary/50 to-indigo-600/50 rounded-[3.2rem] blur opacity-20 group-hover:opacity-40 transition duration-1000 group-hover:duration-200"></div>
        
        <div class="relative bg-slate-900/40 rounded-xl border border-white/10 p-10 md:p-14 shadow-sm overflow-hidden">
          
          <!-- Content Staggered -->
          <div class="flex flex-col items-center text-center mb-10">
            <div class="relative mb-6">
              <div class="absolute inset-0 bg-primary/20 blur-2xl rounded-full scale-120 animate-pulse"></div>
              {#if guildIconUrl}
                <img src={guildIconUrl} alt="Server Logo" class="relative w-24 h-24 rounded-xl object-cover shadow-sm border border-white/10" />
              {:else}
                <div class="relative w-24 h-24 rounded-xl bg-primary/10 flex items-center justify-center border border-primary/20">
                  <Papicon icon="shield" size={48} class="text-primary" />
                </div>
              {/if}
            </div>
            
            <div class="space-y-4">
              <div class="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-amber-500/10 border border-amber-500/20">
                 <Papicon icon="lock" size={14} class="text-amber-500" />
                 <span class="text-xs font-semibold text-amber-500">{m.ctv_security_required()}</span>
              </div>
              <h1 class="font-headline text-3xl font-semibold tracking-tighter text-white leading-tight">
                {m.actx_title()} <br/>
                <span class="text-primary">{selectedGuild?.name || 'Discord'}</span>
              </h1>
              <p class="text-slate-400 font-body text-sm leading-relaxed max-w-[380px] mx-auto opacity-80">
                {m.actx_desc()}
              </p>
            </div>
          </div>

          <!-- Actions & Input -->
          <div class="space-y-6">
            {#if errorMessage}
              <div class="p-4 rounded-xl bg-rose-500/10 border border-rose-500/20 flex items-center gap-4 animate-in fade-in duration-500">
                <div class="bg-rose-500/20 p-2 rounded-xl text-rose-500">
                  <Papicon icon="alert-circle" size={18} />
                </div>
                <p class="text-xs font-bold text-rose-400 leading-relaxed flex-grow">
                  {errorMessage}
                </p>
              </div>
            {/if}

            <div class="space-y-2">
              <label for="activation-code" class="text-xs font-semibold text-slate-500 block ml-1">{m.ctv_global_activation_key()}</label>
              <div class="relative">
                <div class="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500">
                  <Papicon icon="key" size={18} />
                </div>
                <input 
                  type="text" 
                  id="activation-code"
                  bind:value={code}
                  placeholder="KB-XXXX-XXXX-XXXX"
                  disabled={loading}
                  class="w-full pl-12 pr-4 py-4 rounded-xl bg-slate-950/50 border border-white/10 text-white font-mono placeholder:text-slate-600 focus:outline-hidden focus:border-primary/50 transition-colors uppercase"
                />
              </div>
            </div>

            <button 
              onclick={handleActivate}
              disabled={loading}
              class="relative w-full group/btn overflow-hidden"
            >
              <div class="absolute inset-0 bg-primary rounded-xl transition-all duration-500 group-hover/btn:scale-105 group-hover/btn:shadow-[0_0_40px_rgba(51,69,87,0.4)] disabled:opacity-50"></div>
              <div class="relative flex items-center justify-center gap-4 py-5 px-8 text-on-primary font-semibold text-xs transition-transform active:scale-95">
                {#if loading}
                  <div class="animate-spin rounded-full h-4 w-4 border-2 border-white/20 border-t-white"></div>
                  <span>{m.ctv_activation_in_progress()}</span>
                {:else}
                  <div class="bg-white/10 p-2 rounded-xl group-hover/btn:rotate-12 transition-transform">
                    <Papicon icon="check" size={16} />
                  </div>
                  <span>Activer Kotbo</span>
                {/if}
              </div>
            </button>

            <!-- Multi Guild Dropdown Option -->
            {#if authStore.guilds.length > 1}
              <div class="pt-6 border-t border-white/5 space-y-3">
                <label for="guild-select" class="text-xs font-semibold text-slate-500 block text-center">{m.ctv_access_another_server()}</label>
                <div class="relative">
                  <select 
                    id="guild-select"
                    value={authStore.selectedGuildId}
                    onchange={(e) => handleSelectGuild((e.target as HTMLSelectElement).value)}
                    class="w-full px-4 py-3 rounded-lg bg-white/5 border border-white/10 text-xs font-bold text-slate-300 focus:outline-hidden focus:border-primary/30 transition-colors cursor-pointer appearance-none text-center"
                  >
                    {#each authStore.guilds as g}
                      <option value={g.id} class="bg-[#020617] text-slate-300 font-bold">{g.name}</option>
                    {/each}
                  </select>
                </div>
              </div>
            {/if}
          </div>
        </div>
      </div>

      <!-- Helper text -->
      <div class="mt-12 text-center">
        <p class="text-slate-500 text-xs font-medium opacity-40">
          Système de Contrôle Kotbo &copy; {year}
        </p>
      </div>
    </div>
  </main>
</div>

<style>
  @keyframes slide-up { from { transform: translateY(8px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }

  .animate-in {
    animation: slide-up 0.3s ease-out forwards;
  }
</style>
