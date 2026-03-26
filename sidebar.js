// ==========================================
// sidebar.js - Componente de navegação compartilhado
// ==========================================

(function() {
    const paginaAtual = (window.location.pathname.split('/').pop() || 'pedidos').replace(/\.html$/, '');

    function getEmpresaConfig() {
        try { return JSON.parse(localStorage.getItem('empresaConfig') || '{}'); } catch { return {}; }
    }

    function navLink(href, icon, label, pageFile) {
        const pageKey = pageFile.replace(/\.html$/, '');
        const ativo = paginaAtual === pageKey ? 'bg-gray-700' : '';
        return `<a href="${href}" class="text-sm md:text-base text-left p-3 rounded transition flex items-center gap-2 ${ativo}" style="border-radius:8px;" onmouseover="this.style.background='rgba(59,130,246,0.12)'" onmouseout="this.style.background='${paginaAtual === pageKey ? 'rgba(55,65,81,1)' : ''}'">
            ${icon} ${label}
        </a>`;
    }

    const emp = getEmpresaConfig();
    const nomeEmpresa = emp.nome_empresa || 'ZION TECNOLOGIA';

    const sidebarHTML = `
    <aside class="w-full md:w-64 text-white flex flex-col flex-shrink-0" style="background:#05070a;border-right:1px solid rgba(59,130,246,0.15);">
        <div class="p-4 md:p-6 text-center border-b border-gray-700">
            <h1 class="text-xl md:text-2xl font-bold text-blue-400">Matrix <span class="text-white font-light">ERP</span></h1>
            <p id="sidebar-nome-empresa" class="text-xs" style="color:#3b82f6;font-size:10px;letter-spacing:.1em;">${nomeEmpresa}</p>
        </div>
        <nav class="flex flex-row md:flex-col p-4 gap-2 overflow-x-auto whitespace-nowrap">
            ${navLink('dashboard.html', '<i class="fas fa-chart-line"></i>', 'Dashboard', 'dashboard.html')}
            ${navLink('pedidos.html', '📦', 'Gestão de Pedido', 'pedidos.html')}
            ${navLink('clientes.html', '👥', 'Clientes', 'clientes.html')}
            ${navLink('produtos.html', '🏷️', 'Produtos', 'produtos.html')}
            ${navLink('logistica.html', '🚚', 'Painel de Pedidos', 'logistica.html')}
            ${navLink('financeiro.html', '💰', 'Financeiro', 'financeiro.html')}
            <div class="border-t border-gray-700 my-2"></div>
            <button onclick="window.exportarBackupRapido()" class="text-sm md:text-base text-left p-3 rounded hover:bg-gray-600 transition flex items-center gap-2" style="color:#60a5fa;border-radius:8px;" onmouseover="this.style.background='rgba(59,130,246,0.12)'" onmouseout="this.style.background=''">💾 Exportar Backup</button>
            <a href="admin.html" class="text-sm md:text-base text-left p-3 rounded hover:bg-gray-600 transition text-red-400 flex items-center gap-2">🔐 Painel Admin</a>
            <button onclick="window.fazerLogout()" class="mt-auto text-sm text-left p-3 text-red-400 transition font-bold" style="border-radius:8px;" onmouseover="this.style.background='rgba(239,68,68,0.1)'" onmouseout="this.style.background=''">🚪 Encerrar Sessão</button>
        </nav>
    </aside>`;

    const container = document.getElementById('sidebar-container');
    if (container) container.outerHTML = sidebarHTML;

    // Atualiza quando firebase.js termina de carregar a config da empresa
    document.addEventListener('empresaConfigCarregada', (e) => {
        const el = document.getElementById('sidebar-nome-empresa');
        if (el && e.detail.nome_empresa) el.textContent = e.detail.nome_empresa;
    });
})();
