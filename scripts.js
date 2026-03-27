// ==========================================
// scripts.js - Funções globais do MPLEÃO
// ==========================================

let modalProdutosFiltrados = [];
let modalProdutoSelecionadoIndex = -1;
let buscaTimeout = null;
let aguardandoQuantidade = false;
let produtoParaAdicionar = null;

// ==========================================
// FUNÇÕES DO MODAL DE ITENS
// ==========================================

function abrirModalItens() {
    if (!podeEditarPedido()) {
        Swal.fire({ icon: 'error', title: 'Ação bloqueada', text: '❌ Não é possível adicionar itens em um pedido em andamento!', confirmButtonColor: '#3b82f6' });
        return;
    }
    if (!window.bancoProdutos || window.bancoProdutos.length === 0) {
        Swal.fire({ icon: 'warning', title: 'Nenhum produto', text: 'Cadastre produtos primeiro!', confirmButtonColor: '#3b82f6' });
        return;
    }

    modalProdutosFiltrados = [];
    modalProdutoSelecionadoIndex = -1;
    aguardandoQuantidade = false;
    produtoParaAdicionar = null;

    const buscaInput = document.getElementById('busca-produtos-modal');
    if (buscaInput) buscaInput.value = '';

    renderizarListaProdutosVazia();
    document.getElementById('modal-itens').classList.remove('hidden');
    setTimeout(() => { if (buscaInput) buscaInput.focus(); }, 200);
}

function renderizarListaProdutosVazia() {
    const container = document.getElementById('lista-produtos-modal');
    if (!container) return;
    container.innerHTML = `
        <div class="text-center text-gray-500 py-8">
            <p class="text-lg mb-2">🔍 Digite para buscar produtos</p>
            <p class="text-sm">Busque por: código, descrição, categoria, cor ou código de barras</p>
            <p class="text-xs mt-4">Mínimo de 2 caracteres | Setas ⬆️⬇️ para navegar | ENTER para selecionar</p>
        </div>
    `;
}

function fecharModalItens() {
    document.getElementById('modal-itens').classList.add('hidden');
    aguardandoQuantidade = false;
    produtoParaAdicionar = null;
}

function renderizarListaProdutosResultados() {
    const container = document.getElementById('lista-produtos-modal');
    if (!container) return;

    if (modalProdutosFiltrados.length === 0) {
        container.innerHTML = `<div class="text-center text-gray-500 py-8"><p class="text-lg mb-2">😕 Nenhum produto encontrado</p></div>`;
        return;
    }

    let html = '';
    modalProdutosFiltrados.forEach((produto, index) => {
        const selectedClass = index === modalProdutoSelecionadoIndex ? 'bg-blue-100 border-blue-500' : '';

        let estoqueClass = '', estoqueText = '';
        if (produto.estoque_atual !== undefined) {
            if (produto.estoque_atual <= 0) { estoqueClass = 'text-red-600 font-bold'; estoqueText = 'ESGOTADO'; }
            else if (produto.estoque_minimo && produto.estoque_atual <= produto.estoque_minimo) { estoqueClass = 'text-orange-600 font-bold'; estoqueText = 'BAIXO'; }
            else { estoqueClass = 'text-green-600'; estoqueText = `${produto.estoque_atual} em estoque`; }
        }

        html += `
            <div class="flex items-center gap-4 p-3 border rounded-lg hover:bg-blue-50 cursor-pointer produto-item ${selectedClass}"
                 data-index="${index}"
                 onclick="selecionarProdutoModal(${index})"
                 ondblclick="selecionarProdutoParaQuantidade(${index})">
                <div class="flex-1">
                    <div class="flex items-center gap-2">
                        <span class="font-bold text-blue-600 text-sm">#${produto.codigo || '???'}</span>
                        <span class="font-medium">${produto.descricao}</span>
                        ${produto.cor ? `<span class="text-xs bg-gray-100 px-2 py-1 rounded">${produto.cor}</span>` : ''}
                    </div>
                    <div class="text-sm text-gray-600 grid grid-cols-2 gap-x-4 mt-1">
                        <div>
                            ${produto.categoria ? `<span class="text-xs bg-blue-50 px-2 py-0.5 rounded mr-2">${produto.categoria}</span>` : ''}
                            ${produto.marca ? `<span class="text-xs">🏷️ ${produto.marca}</span>` : ''}
                        </div>
                        <div class="text-right">
                            <span class="font-medium">${formatarValorReais(produto.valor_base)}</span>
                            ${produto.unidade ? `<span class="text-xs text-gray-500">/${produto.unidade}</span>` : ''}
                        </div>
                    </div>
                    <div class="flex items-center gap-3 text-xs mt-1">
                        ${produto.codigo_fornecedor ? `<span class="text-gray-500">🏭 Cód.Forn: ${produto.codigo_fornecedor}</span>` : ''}
                        ${produto.codigo_barras ? `<span class="text-gray-500">📊 ${produto.codigo_barras}</span>` : ''}
                        ${estoqueText ? `<span class="${estoqueClass}">📦 ${estoqueText}</span>` : ''}
                    </div>
                </div>
                <div class="w-24">
                    <input type="number" id="qtd-rapida-${index}" value="1" min="1"
                           class="w-full p-1 border rounded text-sm"
                           onclick="event.stopPropagation()"
                           onkeydown="quantidadeKeyDown(event, ${index})">
                </div>
            </div>
        `;
    });

    container.innerHTML = html;

    const infoEl = document.createElement('div');
    infoEl.className = 'text-xs text-gray-500 text-center mt-2';
    infoEl.innerText = `${modalProdutosFiltrados.length} produto(s) encontrado(s)`;
    container.appendChild(infoEl);
}

function selecionarProdutoModal(index) {
    if (index < 0 || index >= modalProdutosFiltrados.length) return;
    modalProdutoSelecionadoIndex = index;

    document.querySelectorAll('.produto-item').forEach(item => item.classList.remove('bg-blue-100', 'border-blue-500'));
    const selectedItem = document.querySelector(`.produto-item[data-index="${index}"]`);
    if (selectedItem) {
        selectedItem.classList.add('bg-blue-100', 'border-blue-500');
        selectedItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
}

function selecionarProdutoParaQuantidade(index) {
    if (index < 0 || index >= modalProdutosFiltrados.length) return;
    const produto = modalProdutosFiltrados[index];
    if (!produto) return;

    if (window.controleEstoqueAtivo && produto.estoque_atual !== undefined && produto.estoque_atual <= 0) {
        Swal.fire({ icon: 'warning', title: 'Produto sem estoque', text: `${produto.descricao} está sem estoque!`, confirmButtonColor: '#3b82f6' });
        return;
    }

    const qtdInput = document.getElementById(`qtd-rapida-${index}`);
    if (qtdInput) {
        qtdInput.focus();
        qtdInput.select();
        aguardandoQuantidade = true;
        produtoParaAdicionar = { produto, index };
    }
}

function quantidadeKeyDown(event, index) {
    if (event.key !== 'Enter') return;
    event.preventDefault();

    const produto = modalProdutosFiltrados[index];
    if (!produto) return;

    const qtdInput = document.getElementById(`qtd-rapida-${index}`);
    const quantidade = qtdInput ? parseInt(qtdInput.value) || 1 : 1;

    if (window.controleEstoqueAtivo && produto.estoque_atual !== undefined && quantidade > produto.estoque_atual) {
        Swal.fire({ icon: 'warning', title: 'Quantidade maior que estoque', text: `Estoque atual: ${produto.estoque_atual} ${produto.unidade || 'un'}`, confirmButtonColor: '#3b82f6' });
        return;
    }

    adicionarProdutoNaTabela(produto, quantidade);
    aguardandoQuantidade = false;
    produtoParaAdicionar = null;

    const buscaInput = document.getElementById('busca-produtos-modal');
    const termoAtual = buscaInput ? buscaInput.value : '';
    if (termoAtual && termoAtual.length >= 2) {
        setTimeout(() => filtrarProdutosModal(termoAtual), 50);
    } else {
        renderizarListaProdutosVazia();
    }
    setTimeout(() => { if (buscaInput) { buscaInput.focus(); buscaInput.select(); } }, 100);
}

function filtrarProdutosModal(termo) {
    if (buscaTimeout) clearTimeout(buscaTimeout);

    if (!termo || termo.length < 2) {
        modalProdutosFiltrados = [];
        modalProdutoSelecionadoIndex = -1;
        renderizarListaProdutosVazia();
        return;
    }

    buscaTimeout = setTimeout(() => {
        const tl = termo.toLowerCase();
        modalProdutosFiltrados = window.bancoProdutos.filter(p =>
            (p.codigo && p.codigo.toString().includes(tl)) ||
            (p.codigo_fornecedor && p.codigo_fornecedor.toLowerCase().includes(tl)) ||
            (p.codigo_barras && p.codigo_barras.toLowerCase().includes(tl)) ||
            (p.descricao && p.descricao.toLowerCase().includes(tl)) ||
            (p.fornecedor && p.fornecedor.toLowerCase().includes(tl)) ||
            (p.categoria && p.categoria.toLowerCase().includes(tl)) ||
            (p.cor && p.cor.toLowerCase().includes(tl)) ||
            (p.marca && p.marca.toLowerCase().includes(tl))
        );

        if (modalProdutosFiltrados.length > 50) modalProdutosFiltrados = modalProdutosFiltrados.slice(0, 50);

        modalProdutosFiltrados.sort((a, b) => (parseInt(a.codigo) || 0) - (parseInt(b.codigo) || 0));
        modalProdutoSelecionadoIndex = modalProdutosFiltrados.length > 0 ? 0 : -1;
        renderizarListaProdutosResultados();
        if (modalProdutosFiltrados.length > 0) selecionarProdutoModal(0);
    }, 300);
}

function adicionarProdutoNaTabela(produto, quantidade) {
    const tbody = document.getElementById('tabela-itens');

    // Remove mensagem de "nenhum item"
    const mensagemVazia = tbody.querySelector('tr td[colspan]');
    if (mensagemVazia) mensagemVazia.closest('tr').remove();

    const linhaAdicionar = document.getElementById('linha-adicionar');
    if (linhaAdicionar) linhaAdicionar.remove();

    const novaLinha = document.createElement('tr');
    novaLinha.className = 'text-sm';
    // CORRIGIDO: guarda o id do produto no dataset da linha para salvar corretamente
    novaLinha.dataset.produtoId = produto.id || '';

    const selectId = 'produto-select-' + Date.now() + '-' + Math.random().toString(36).substr(2, 5);

    // CORRIGIDO: value do option é p.id (não a descrição)
    let selectHtml = `<select id="${selectId}" class="w-full p-1 border rounded desc-item border-blue-300 focus:ring-2 focus:ring-blue-500 bg-gray-50 produto-select" style="width: 100%;" onchange="window.preencherProduto(this)">`;
    selectHtml += '<option value="">Selecione um produto</option>';

    if (window.bancoProdutos && window.bancoProdutos.length > 0) {
        window.bancoProdutos.forEach(p => {
            const selected = p.id === produto.id ? 'selected' : '';
            selectHtml += `<option value="${p.id}" data-valor="${p.valor_base}" data-forn="${p.fornecedor || ''}" data-desc="${p.descricao}" ${selected}>${p.codigo ? '#' + p.codigo + ' - ' : ''}${p.descricao} - ${formatarValorReais(p.valor_base)}</option>`;
        });
    }
    selectHtml += '</select>';

    novaLinha.innerHTML = `
        <td class="p-2 border"><input type="number" value="${quantidade}" min="1" class="w-16 p-1 border rounded qtd-item" onchange="calcularTudo()" onkeyup="calcularTudo()"></td>
        <td class="p-2 border">${selectHtml}</td>
        <td class="p-2 border"><input type="text" value="${produto.fornecedor || ''}" class="w-full p-1 border rounded forn-item bg-gray-100" readonly></td>
        <td class="p-2 border"><input type="text" value="${formatarValorReais(produto.valor_base)}" class="w-24 p-1 border rounded valor-item bg-gray-100 text-right" readonly></td>
        <td class="p-2 border text-center"><input type="number" value="0" min="0" max="100" step="0.1" class="w-14 p-1 border rounded desconto-item text-center text-green-700 font-medium" title="Desconto (%)" onchange="calcularTudo()" onkeyup="calcularTudo()"></td>
        <td class="p-2 border total-linha">R$ 0,00</td>
        <td class="p-2 border text-center"><button onclick="if(podeEditarPedido()) { this.closest('tr').remove(); setTimeout(calcularTudo, 50); } else { Swal.fire({ icon: 'error', title: 'Ação bloqueada', text: '❌ Não é possível remover itens de um pedido em andamento!', confirmButtonColor: '#3b82f6' }); }" class="text-red-500 font-bold hover:text-red-700">X</button></td>
    `;

    tbody.appendChild(novaLinha);

    setTimeout(() => {
        try {
            const newSelect = document.getElementById(selectId);
            if (newSelect && $.fn && $.fn.select2) {
                $(newSelect).select2({ placeholder: "Busque um produto...", allowClear: true, width: '100%' });
            }
        } catch (e) { console.warn('Erro ao inicializar Select2:', e); }
    }, 100);

    setTimeout(calcularTudo, 50);
}

function adicionarProdutosSelecionados() {
    fecharModalItens();
}

// ==========================================
// CADASTRO COMPLETO DE PRODUTO
// ==========================================

function gerarProximoCodigoProduto() {
    if (!window.bancoProdutos || window.bancoProdutos.length === 0) return '001';
    let maxCodigo = 0;
    window.bancoProdutos.forEach(p => {
        if (p.codigo) { const num = parseInt(p.codigo); if (!isNaN(num) && num > maxCodigo) maxCodigo = num; }
    });
    return (maxCodigo + 1).toString().padStart(3, '0');
}

function setupEnterNavigation(modal) {
    const inputs = modal.querySelectorAll('input, select, textarea');
    inputs.forEach((input, index) => {
        input.addEventListener('keydown', function(e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                if (index === inputs.length - 1) {
                    const confirmButton = modal.querySelector('.swal2-confirm');
                    if (confirmButton) confirmButton.click();
                } else {
                    const next = inputs[index + 1];
                    if (next) { next.focus(); if (['text','number'].includes(next.type) || next.tagName === 'TEXTAREA') next.select(); }
                }
            }
        });
    });
}

function abrirCadastroCompletoProduto(produtoId = null) {
    const produto = produtoId ? window.bancoProdutos.find(p => p.id === produtoId) : null;
    const categorias = [...new Set((window.bancoProdutos || []).map(p => p.categoria).filter(c => c))];
    const marcas = [...new Set((window.bancoProdutos || []).map(p => p.marca).filter(m => m))];
    const codigoAutomatico = produto ? produto.codigo : gerarProximoCodigoProduto();

    Swal.fire({
        title: produto ? '✏️ Editar Produto' : '➕ Novo Produto',
        html: `
            <div class="text-left space-y-3 max-h-[60vh] overflow-y-auto p-2">
                <div class="grid grid-cols-2 gap-2">
                    <div>
                        <label class="text-xs font-medium">Código Interno *</label>
                        <input id="swal-prod-codigo" class="w-full p-2 border rounded text-sm bg-gray-100 cursor-not-allowed" value="${codigoAutomatico}" readonly tabindex="-1">
                        <p class="text-xs text-gray-500 mt-1">🔒 Automático</p>
                    </div>
                    <div>
                        <label class="text-xs font-medium">Cód. Fornecedor</label>
                        <input id="swal-prod-codigo-forn" class="w-full p-2 border rounded text-sm" value="${produto ? produto.codigo_fornecedor || '' : ''}" placeholder="Ex: 2533101">
                    </div>
                    <div>
                        <label class="text-xs font-medium">Código de Barras</label>
                        <input id="swal-prod-codigo-barras" class="w-full p-2 border rounded text-sm" value="${produto ? produto.codigo_barras || '' : ''}" placeholder="789...">
                    </div>
                </div>
                <div>
                    <label class="text-xs font-medium">Descrição do Produto *</label>
                    <input id="swal-prod-descricao" class="w-full p-2 border rounded text-sm" value="${produto ? produto.descricao || '' : ''}" placeholder="Ex: Porta de Madeira">
                </div>
                <div class="grid grid-cols-2 gap-2">
                    <div>
                        <label class="text-xs font-medium">Categoria</label>
                        <input id="swal-prod-categoria" class="w-full p-2 border rounded text-sm" value="${produto ? produto.categoria || '' : ''}" list="categorias-list">
                        <datalist id="categorias-list">${categorias.map(c => `<option value="${c}">`).join('')}</datalist>
                    </div>
                    <div>
                        <label class="text-xs font-medium">Marca / Fabricante</label>
                        <input id="swal-prod-marca" class="w-full p-2 border rounded text-sm" value="${produto ? produto.marca || '' : ''}" list="marcas-list">
                        <datalist id="marcas-list">${marcas.map(m => `<option value="${m}">`).join('')}</datalist>
                    </div>
                </div>
                <div class="grid grid-cols-3 gap-2">
                    <div>
                        <label class="text-xs font-medium">Fornecedor</label>
                        <input id="swal-prod-fornecedor" class="w-full p-2 border rounded text-sm" value="${produto ? produto.fornecedor || '' : ''}">
                    </div>
                    <div>
                        <label class="text-xs font-medium">Cor</label>
                        <input id="swal-prod-cor" class="w-full p-2 border rounded text-sm" value="${produto ? produto.cor || '' : ''}">
                    </div>
                    <div>
                        <label class="text-xs font-medium">Unidade</label>
                        <select id="swal-prod-unidade" class="w-full p-2 border rounded text-sm">
                            <option value="UN" ${produto?.unidade === 'UN' ? 'selected' : ''}>UN - Unidade</option>
                            <option value="M2" ${produto?.unidade === 'M2' ? 'selected' : ''}>M²</option>
                            <option value="MT" ${produto?.unidade === 'MT' ? 'selected' : ''}>MT - Metro</option>
                            <option value="KIT" ${produto?.unidade === 'KIT' ? 'selected' : ''}>KIT</option>
                            <option value="CX" ${produto?.unidade === 'CX' ? 'selected' : ''}>CX - Caixa</option>
                            <option value="PC" ${produto?.unidade === 'PC' ? 'selected' : ''}>PC - Peça</option>
                            <option value="KG" ${produto?.unidade === 'KG' ? 'selected' : ''}>KG</option>
                        </select>
                    </div>
                </div>
                <div class="grid grid-cols-2 gap-2">
                    <div>
                        <label class="text-xs font-medium">Preço de Custo (R$)</label>
                        <input id="swal-prod-custo" class="w-full p-2 border rounded text-sm text-right" value="${produto?.custo ? produto.custo.toLocaleString('pt-BR', {minimumFractionDigits:2,maximumFractionDigits:2}) : '0,00'}" onkeyup="formatarValorInput(this)">
                    </div>
                    <div>
                        <label class="text-xs font-medium">Preço de Venda (R$) *</label>
                        <input id="swal-prod-valor" class="w-full p-2 border rounded text-sm text-right font-bold text-blue-600" value="${produto ? produto.valor_base.toLocaleString('pt-BR', {minimumFractionDigits:2,maximumFractionDigits:2}) : '0,00'}" onkeyup="formatarValorInput(this)">
                    </div>
                </div>
                <div class="grid grid-cols-2 gap-2">
                    <div>
                        <label class="text-xs font-medium">Estoque Mínimo</label>
                        <input id="swal-prod-estoque-min" type="number" min="0" class="w-full p-2 border rounded text-sm" value="${produto?.estoque_minimo !== undefined ? produto.estoque_minimo : '0'}">
                    </div>
                    <div>
                        <label class="text-xs font-medium">Estoque Atual</label>
                        <input id="swal-prod-estoque-atual" type="number" min="0" class="w-full p-2 border rounded text-sm" value="${produto?.estoque_atual !== undefined ? produto.estoque_atual : '0'}">
                    </div>
                </div>
                <div>
                    <label class="text-xs font-medium">Observações</label>
                    <textarea id="swal-prod-obs" class="w-full p-2 border rounded text-sm" rows="2">${produto ? produto.observacoes || '' : ''}</textarea>
                </div>
            </div>
        `,
        showCancelButton: true,
        confirmButtonText: produto ? '💾 Atualizar' : '✅ Cadastrar',
        cancelButtonText: 'Cancelar',
        confirmButtonColor: '#3b82f6',
        cancelButtonColor: '#6b7280',
        width: '700px',
        didOpen: (modal) => {
            setTimeout(() => document.getElementById('swal-prod-descricao').focus(), 100);
            setupEnterNavigation(modal);
        },
        preConfirm: () => {
            const codigo = document.getElementById('swal-prod-codigo').value.trim();
            const descricao = document.getElementById('swal-prod-descricao').value.trim();
            const valorTexto = document.getElementById('swal-prod-valor').value;
            if (!codigo) { Swal.showValidationMessage('Código é obrigatório'); return false; }
            if (!descricao) { Swal.showValidationMessage('Descrição é obrigatória'); return false; }
            const valor = parseFloat(valorTexto.replace(/[^\d,]/g, '').replace(',', '.')) || 0;
            if (valor <= 0) { Swal.showValidationMessage('Preço de venda deve ser maior que zero'); return false; }
            const codigoExiste = (window.bancoProdutos || []).some(p => p.codigo === codigo && p.id !== (produto?.id));
            if (codigoExiste) { Swal.showValidationMessage(`Código ${codigo} já está em uso!`); return false; }
            return {
                codigo, descricao,
                codigo_fornecedor: document.getElementById('swal-prod-codigo-forn').value.trim(),
                codigo_barras: document.getElementById('swal-prod-codigo-barras').value.trim(),
                categoria: document.getElementById('swal-prod-categoria').value.trim(),
                marca: document.getElementById('swal-prod-marca').value.trim(),
                fornecedor: document.getElementById('swal-prod-fornecedor').value.trim(),
                cor: document.getElementById('swal-prod-cor').value.trim(),
                unidade: document.getElementById('swal-prod-unidade').value,
                custo: parseFloat(document.getElementById('swal-prod-custo').value.replace(/[^\d,]/g, '').replace(',', '.')) || 0,
                valor_base: valor,
                estoque_minimo: parseInt(document.getElementById('swal-prod-estoque-min').value) || 0,
                estoque_atual: parseInt(document.getElementById('swal-prod-estoque-atual').value) || 0,
                observacoes: document.getElementById('swal-prod-obs').value.trim()
            };
        }
    }).then(async (result) => {
        // Libera o lock independente de salvar ou cancelar
        if (typeof window.liberarLock === 'function') window.liberarLock();
        if (!result.isConfirmed) return;
        try {
            if (!window.db) { Swal.fire({ icon: 'error', title: 'Erro', text: 'Firebase não disponível.', confirmButtonColor: '#3b82f6' }); return; }
            if (produto) {
                await window.updateDoc(window.doc(window.db, "produtos", produto.id), result.value);
                Swal.fire({ icon: 'success', title: 'Produto atualizado!', text: `${result.value.codigo} - ${result.value.descricao}`, timer: 2000, showConfirmButton: false });
            } else {
                await window.addDoc(window.collection(window.db, "produtos"), { ...result.value, data_cadastro: window.serverTimestamp() });
                Swal.fire({ icon: 'success', title: 'Produto cadastrado!', text: `${result.value.codigo} - ${result.value.descricao}`, timer: 2000, showConfirmButton: false });
            }
            if (typeof window.carregarMemoriaBanco === 'function') await window.carregarMemoriaBanco();
        } catch (error) {
            console.error('Erro ao salvar produto:', error);
            Swal.fire({ icon: 'error', title: 'Erro', text: 'Erro ao salvar produto: ' + error.message, confirmButtonColor: '#3b82f6' });
        }
    });
}

// ==========================================
// TECLADO GLOBAL (MODAL)
// ==========================================
document.addEventListener('keydown', handleModalKeyDown);

function handleModalKeyDown(event) {
    const modal = document.getElementById('modal-itens');
    if (!modal || modal.classList.contains('hidden')) return;

    const buscaInput = document.getElementById('busca-produtos-modal');
    const isBuscaFocused = document.activeElement === buscaInput;

    if (event.key === 'Escape') { fecharModalItens(); event.preventDefault(); return; }
    if (aguardandoQuantidade) return;

    if (event.key === 'ArrowDown' && isBuscaFocused && modalProdutosFiltrados.length > 0) {
        event.preventDefault();
        selecionarProdutoModal((modalProdutoSelecionadoIndex + 1) % modalProdutosFiltrados.length);
    }
    if (event.key === 'ArrowUp' && isBuscaFocused && modalProdutosFiltrados.length > 0) {
        event.preventDefault();
        const prev = modalProdutoSelecionadoIndex - 1;
        selecionarProdutoModal(prev < 0 ? modalProdutosFiltrados.length - 1 : prev);
    }
    if (event.key === 'Enter' && isBuscaFocused && modalProdutoSelecionadoIndex >= 0) {
        event.preventDefault();
        selecionarProdutoParaQuantidade(modalProdutoSelecionadoIndex);
    }
}

// ==========================================
// NAVEGAÇÃO
// ==========================================
function mostrarAba(abaId) {
    const pageMap = {
        'aba-cadastro':  'pedidos.html',
        'aba-clientes':  'clientes.html',
        'aba-produtos':  'produtos.html',
        'aba-logistica': 'logistica.html',
        'aba-financeiro':'financeiro.html'
    };

    // Se o elemento não existe nesta página, navega para a página correta
    const abaEl = document.getElementById(abaId);
    if (!abaEl) {
        if (pageMap[abaId]) window.location.href = pageMap[abaId];
        return;
    }

    // Compatibilidade: caso ainda haja múltiplas abas na mesma página (index.html legado)
    ['aba-cadastro','aba-clientes','aba-produtos','aba-logistica','aba-financeiro'].forEach(aba => {
        const el = document.getElementById(aba);
        if (el) el.classList.add('hidden');
    });
    abaEl.classList.remove('hidden');

    if (abaId === 'aba-financeiro' && typeof window.carregarDadosFinanceiros === 'function') {
        window.carregarDadosFinanceiros();
    }
}

// ==========================================
// FORMATAÇÃO
// ==========================================
function formatarValorReais(valor) {
    if (valor === undefined || valor === null) return 'R$ 0,00';
    const num = typeof valor === 'string' ? parseFloat(valor) : valor;
    if (isNaN(num)) return 'R$ 0,00';
    return 'R$ ' + num.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatarTelefone(input) {
    if (!input) return;
    let n = input.value.replace(/\D/g, '');
    n = n.length <= 10 ? n.replace(/^(\d{2})(\d{4})(\d{4})/, '($1) $2-$3') : n.replace(/^(\d{2})(\d{5})(\d{4})/, '($1) $2-$3');
    input.value = n;
}

function formatarValorInput(input) {
    if (!input) return;
    let valor = input.value.replace(/[^\d]/g, '');
    if (valor === '') { input.value = ''; return; }
    input.value = (parseInt(valor) / 100).toFixed(2).replace('.', ',');
}

function formatarDataParaExibir(dataISO) {
    if (!dataISO) return '-';
    try { return new Date(dataISO + 'T12:00:00').toLocaleDateString('pt-BR'); } catch (e) { return dataISO; }
}

function formatarCEP(input) {
    if (!input) return;
    let cep = input.value.replace(/\D/g, '');
    if (cep.length > 5) cep = cep.substring(0, 5) + '-' + cep.substring(5, 8);
    input.value = cep;
}

// ==========================================
// HELPERS
// ==========================================
function adicionarLinha() {
    // Mantida para compatibilidade — não utilizada
}

function podeEditarPedido() {
    const status = document.getElementById('select-status')?.value || 'Orçamento';
    return !['Produção', 'Em Entrega', 'Entregue'].includes(status);
}

// ==========================================
// CÁLCULOS
// ==========================================
// --- SUBSTITUA A FUNÇÃO calcularTudo EXISTENTE ---
function calcularTudo() {
    const linhas = [...document.querySelectorAll('#tabela-itens tr')].filter(tr => tr.querySelector('.produto-select'));

    let subtotal = 0;
    linhas.forEach(linha => {
        const qtdInput = linha.querySelector('.qtd-item');
        const valorInput = linha.querySelector('.valor-item');
        const descontoInput = linha.querySelector('.desconto-item');
        const totalLinhaEl = linha.querySelector('.total-linha');
        if (!qtdInput || !valorInput || !totalLinhaEl) return;

        const qtd = parseFloat(qtdInput.value) || 0;
        const valor = parseFloat((valorInput.value || '0').replace('R$', '').replace(/\./g, '').replace(',', '.')) || 0;
        const descPct = parseFloat(descontoInput?.value || '0') || 0;
        const totalLinha = qtd * valor * (1 - descPct / 100);
        totalLinhaEl.innerText = formatarValorReais(totalLinha);
        subtotal += totalLinha;
    });

    const pctDesconto = parseFloat(document.getElementById('input-desconto')?.value?.replace(',', '.')) || 0;
    const valorDesconto = subtotal * (pctDesconto / 100);
    const subtotalComDesconto = subtotal - valorDesconto;

    const acrescimo = parseFloat((document.getElementById('input-acrescimo')?.value || '0').replace(/[^\d,]/g, '').replace(',', '.')) || 0;

    const km = parseFloat(document.getElementById('input-km')?.value) || 0;
    const litro = parseFloat(document.getElementById('input-litro')?.value) || 4.20;
    const consumo = parseFloat(document.getElementById('input-consumo')?.value) || 9.0;
    
    // CÁLCULO DO FRETE (KM / CONSUMO * PREÇO * 2 para ida e volta)
    const custoCombustivel = km > 0 ? (km / consumo) * litro * 2 : 0;
    const pedagio = parseFloat((document.getElementById('input-pedagio')?.value || '0').replace(/[^\d,]/g, '').replace(',', '.')) || 0;
    const freteTotal = custoCombustivel + pedagio;

    const el = (id) => document.getElementById(id);
    if (el('custo-combustivel')) el('custo-combustivel').innerText = formatarValorReais(custoCombustivel);
    if (el('custo-pedagio')) el('custo-pedagio').innerText = formatarValorReais(pedagio);
    if (el('custo-total-frete')) el('custo-total-frete').innerText = formatarValorReais(freteTotal);
    if (el('display-frete-estimado')) el('display-frete-estimado').value = formatarValorReais(freteTotal);

    const formaPgto = el('select-pagamento')?.value;
    let taxaCartao = 0;
    if (formaPgto === 'Cartão de Crédito') {
        taxaCartao = (subtotalComDesconto + freteTotal + acrescimo) * 0.05;
        if (el('info-taxa')) { el('info-taxa').innerText = `Taxa Maquininha (5%): ${formatarValorReais(taxaCartao)}`; el('info-taxa').classList.remove('hidden'); }
    } else if (el('info-taxa')) {
        el('info-taxa').classList.add('hidden');
    }

    const totalGeral = subtotalComDesconto + freteTotal + taxaCartao + acrescimo;

    if (el('display-subtotal')) el('display-subtotal').innerText = 'Subtotal: ' + formatarValorReais(subtotal);
    if (el('display-desconto')) el('display-desconto').innerText = 'Desconto: - ' + formatarValorReais(valorDesconto);
    if (el('display-acrescimo')) el('display-acrescimo').innerText = 'Acréscimo: + ' + formatarValorReais(acrescimo);
    if (el('display-frete-final')) el('display-frete-final').innerText = 'Frete: ' + formatarValorReais(freteTotal);
    if (el('display-taxa-final')) {
        if (taxaCartao > 0) { el('display-taxa-final').innerText = 'Taxa Cartão: ' + formatarValorReais(taxaCartao); el('display-taxa-final').classList.remove('hidden'); }
        else el('display-taxa-final').classList.add('hidden');
    }
    if (el('display-total')) el('display-total').innerText = 'Total: ' + formatarValorReais(totalGeral);
    if (el('btn-gerar-pdf')) el('btn-gerar-pdf').setAttribute('data-total', totalGeral.toFixed(2).replace('.', ','));
}

// --- ADICIONE ESTA FUNÇÃO NO FINAL DO scripts.js ---
async function carregarConfigsFreteNoPedido() {
    try {
        const { getFirestore, doc, getDoc } = await import("https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js" );
        const db = window.db;
        const snap = await getDoc(doc(db, 'configuracoes', 'frete'));
        if (snap.exists()) {
            const d = snap.data();
            if (document.getElementById('input-litro')) document.getElementById('input-litro').value = d.litro || 4.20;
            if (document.getElementById('input-consumo')) document.getElementById('input-consumo').value = d.consumo || 9.0;
            console.log('✅ Configurações de frete carregadas do Admin');
            calcularTudo();
        }
    } catch(e) { console.warn('Erro ao carregar configs de frete:', e); }
}
// Chama ao carregar a página
window.addEventListener('load', carregarConfigsFreteNoPedido);


// ==========================================
// PDF
// ==========================================
async function gerarPDF() {
    const btn = document.getElementById('btn-gerar-pdf');
    if (!btn) return;

    // ── VALIDAÇÕES ──────────────────────────────────────────────────────
    const nomeCliente = document.getElementById('input-cliente')?.value?.trim();
    if (!nomeCliente) {
        Swal.fire({ icon: 'warning', title: 'Cliente obrigatório', text: 'Selecione um cliente antes de imprimir.', confirmButtonColor: '#3b82f6' });
        return;
    }

    const linhasItens = [...document.querySelectorAll('#tabela-itens tr')].filter(tr => tr.querySelector('.produto-select'));
    if (linhasItens.length === 0) {
        Swal.fire({ icon: 'warning', title: 'Sem itens', text: 'Adicione pelo menos um item ao pedido antes de imprimir.', confirmButtonColor: '#3b82f6' });
        return;
    }

    const totalAttr = parseFloat((btn.getAttribute('data-total') || '0').replace(',', '.'));
    if (!totalAttr || totalAttr <= 0) {
        Swal.fire({ icon: 'warning', title: 'Total inválido', text: 'O valor total do pedido está zerado. Verifique os itens.', confirmButtonColor: '#3b82f6' });
        return;
    }

    // ── SALVAR AUTOMATICAMENTE SE AINDA NÃO FOI SALVO ───────────────────
    const pedidoId = document.getElementById('pedido-id')?.value || '';
    if (!pedidoId) {
        const confirm = await Swal.fire({
            icon: 'question',
            title: 'Pedido não salvo',
            text: 'O pedido ainda não foi salvo. Deseja salvar agora e gerar o PDF?',
            showCancelButton: true,
            confirmButtonText: '💾 Salvar e Imprimir',
            cancelButtonText: 'Cancelar',
            confirmButtonColor: '#3b82f6',
            cancelButtonColor: '#6b7280'
        });
        if (!confirm.isConfirmed) return;

        // Salva o pedido antes de gerar
        btn.disabled = true;
        btn.innerHTML = '💾 Salvando...';
        try {
            await window.salvarPedidoAtual();
            // Aguarda o pdf-n-display ser preenchido com o número real (máx 3s)
            await new Promise((resolve) => {
                const inicio = Date.now();
                const checar = setInterval(() => {
                    const num = document.getElementById('pdf-n-display')?.innerText || '';
                    if (num && num !== 'NOVO' && num !== '') {
                        clearInterval(checar);
                        resolve();
                    } else if (Date.now() - inicio > 3000) {
                        clearInterval(checar);
                        resolve(); // timeout — segue mesmo assim
                    }
                }, 100);
            });
        } catch(e) {
            btn.disabled = false;
            btn.innerHTML = '🖨️ Imprimir Pedido';
            return; // salvarPedidoAtual já mostra o erro
        }
        btn.disabled = false;
        btn.innerHTML = '🖨️ Imprimir PDF';
    }

    // ── BUSCA DADOS COMPLETOS DO CLIENTE ────────────────────────────────
    const clienteObj = window.bancoClientes?.find(c => c.nome === nomeCliente) || {};
    const textoOriginal = '🖨️ Imprimir PDF';
    btn.innerHTML = '✨ Gerando PDF...';
    btn.disabled = true;

    const numeroExibicao = (document.getElementById('pdf-n-display')?.innerText || '').trim();
    // Remove o # para o nome do arquivo, mantém para exibição
    const numeroFinal = (numeroExibicao && numeroExibicao !== 'NOVO' && numeroExibicao !== '')
        ? numeroExibicao.replace('#', '')
        : '???';
    const numeroDisplay = numeroFinal !== '???' ? '#' + numeroFinal : '???';
    const endereco = document.getElementById('input-endereco')?.value || clienteObj.endereco || '';
    const previsao = document.getElementById('input-previsao')?.value || 'A combinar';
    const dataAtual = new Date().toLocaleDateString('pt-BR');
    const totalGeral = btn.getAttribute('data-total') || totalAttr.toFixed(2).replace('.', ',');
	
	//novas impressão - forma de pagamento
	
	const formaPagamento = document.getElementById('select-pagamento')?.value || 'Não informado';
let condicaoPagamento = document.getElementById('select-condicao-pagamento')?.value || '';

if (condicaoPagamento.toLowerCase() === 'vista') {
    condicaoPagamento = 'À vista';
}

    // Monta bloco de dados do cliente com tudo que tiver preenchido
    let dadosClienteHtml = `<p style="margin:0 0 6px 0; font-size:14px; font-weight:bold;">${nomeCliente}</p>`;
    if (clienteObj.documento) dadosClienteHtml += `<p style="margin:3px 0; font-size:12px;"><strong>CPF/CNPJ:</strong> ${clienteObj.documento}</p>`;
    if (clienteObj.telefone)  dadosClienteHtml += `<p style="margin:3px 0; font-size:12px;"><strong>Telefone:</strong> ${clienteObj.telefone}</p>`;
    if (clienteObj.email)     dadosClienteHtml += `<p style="margin:3px 0; font-size:12px;"><strong>E-mail:</strong> ${clienteObj.email}</p>`;
    if (endereco)             dadosClienteHtml += `<p style="margin:3px 0; font-size:12px;"><strong>Endereço:</strong> ${endereco}</p>`;
    if (clienteObj.cep)       dadosClienteHtml += `<p style="margin:3px 0; font-size:12px;"><strong>CEP:</strong> ${clienteObj.cep}</p>`;
dadosClienteHtml += `<p style="margin:6px 0 0 0; font-size:12px;"><strong>Previsão de Entrega:</strong> ${previsao}</p>`;

dadosClienteHtml += `<p style="margin:6px 0 0 0; font-size:12px;">
    <strong>Forma de Pagamento:</strong> ${formaPagamento}
</p>`;

if (condicaoPagamento) {
    dadosClienteHtml += `<p style="margin:3px 0; font-size:12px;">
        <strong>Condição:</strong> ${condicaoPagamento}
    </p>`;
}

    // Monta linhas dos itens
    let linhasHtml = '';
    let temDescontoItem = false;
    document.querySelectorAll('#tabela-itens tr:not(#linha-adicionar)').forEach(linha => {
        const descPct = parseFloat(linha.querySelector('.desconto-item')?.value || '0') || 0;
        if (descPct > 0) temDescontoItem = true;
    });
    document.querySelectorAll('#tabela-itens tr:not(#linha-adicionar)').forEach(linha => {
        const qtd = linha.querySelector('.qtd-item')?.value || '0';
        const select = linha.querySelector('.desc-item');
        let desc = '';
        if (select && select.selectedIndex >= 0) {
            const opt = select.options[select.selectedIndex];
            desc = opt?.dataset?.desc || opt?.text?.split(' - ')[0] || '';
        }
        const valorRaw = parseFloat((linha.querySelector('.valor-item')?.value || '0').replace(/[^\d,]/g,'').replace(',','.')) || 0;
        const valorUnit = formatarValorReais(valorRaw);
        const descPct = parseFloat(linha.querySelector('.desconto-item')?.value || '0') || 0;
        const total = linha.querySelector('.total-linha')?.innerText || 'R$ 0,00';
        if (desc) {
            const colunaDesc = temDescontoItem
                ? `<td style="padding:8px;text-align:center;border:1px solid #ddd;color:#16a34a;">${descPct > 0 ? descPct.toFixed(1).replace('.',',') + '%' : '-'}</td>`
                : '';
            linhasHtml += `
                <tr style="border-bottom:1px solid #eee;">
                    <td style="padding:8px;text-align:center;border:1px solid #ddd;">${qtd}</td>
                    <td style="padding:8px;border:1px solid #ddd;">${desc}</td>
                    <td style="padding:8px;text-align:right;border:1px solid #ddd;">${valorUnit}</td>
                    ${colunaDesc}
                    <td style="padding:8px;text-align:right;font-weight:bold;border:1px solid #ddd;">${total}</td>
                </tr>`;
        }
    });

    // Lê breakdown de totais direto dos elementos já formatados na tela
    const elSubtotal  = document.getElementById('display-subtotal')?.innerText  || '';
    const elDesconto  = document.getElementById('display-desconto')?.innerText  || '';
    const elAcrescimo = document.getElementById('display-acrescimo')?.innerText || '';
    const elFrete     = document.getElementById('display-frete-final')?.innerText || '';
    const elTaxa      = document.getElementById('display-taxa-final');
    const taxaVisivel = elTaxa && !elTaxa.classList.contains('hidden');
    const elTaxaText  = taxaVisivel ? elTaxa.innerText : '';

    // Formata o total com milhar corretamente
    const totalNum = parseFloat((btn.getAttribute('data-total') || '0').replace(/\./g,'').replace(',','.'));
    const totalFormatado = formatarValorReais(totalNum);

    // Monta linhas do breakdown — só mostra desconto/acréscimo/frete se diferente de zero
    const descontoNum  = parseFloat((elDesconto.match(/[\d,.]+/) || ['0'])[0].replace(/\./g,'').replace(',','.')) || 0;
    const acrescimoNum = parseFloat((elAcrescimo.match(/[\d,.]+/) || ['0'])[0].replace(/\./g,'').replace(',','.')) || 0;
    const freteNum     = parseFloat((elFrete.match(/[\d,.]+/) || ['0'])[0].replace(/\./g,'').replace(',','.')) || 0;

    let breakdownHtml = `<tr><td style="padding:5px 10px;color:#555;">Subtotal</td><td style="padding:5px 10px;text-align:right;">${elSubtotal.replace('Subtotal: ','')}</td></tr>`;
    if (descontoNum  > 0) breakdownHtml += `<tr><td style="padding:5px 10px;color:#16a34a;">Desconto</td><td style="padding:5px 10px;text-align:right;color:#16a34a;">- ${formatarValorReais(descontoNum)}</td></tr>`;
    if (acrescimoNum > 0) breakdownHtml += `<tr><td style="padding:5px 10px;color:#d97706;">Acréscimo</td><td style="padding:5px 10px;text-align:right;color:#d97706;">+ ${formatarValorReais(acrescimoNum)}</td></tr>`;
    if (freteNum     > 0) breakdownHtml += `<tr><td style="padding:5px 10px;color:#555;">Frete</td><td style="padding:5px 10px;text-align:right;">${formatarValorReais(freteNum)}</td></tr>`;
    if (taxaVisivel && elTaxaText) breakdownHtml += `<tr><td style="padding:5px 10px;color:#7c3aed;">Taxa Cartão</td><td style="padding:5px 10px;text-align:right;color:#7c3aed;">${elTaxaText.replace(/.*: /,'')}</td></tr>`;

    // Lê identidade da empresa do cache local
    let _emp = {};
    try { _emp = JSON.parse(localStorage.getItem('empresaConfig') || '{}'); } catch(e) {}
    const _nomeEmpresaPDF    = _emp.nome_empresa    || '';
    const _sloganPDF         = _emp.slogan          || '';
    const _documentoPDF      = _emp.documento       || '';
    const _telefonePDF       = _emp.telefone        || '';
    const _enderecoPDF       = _emp.endereco        || '';
    const _modoImpressao     = _emp.impressao_modo  || 'simples';

    // Monta cabeçalho da empresa conforme modo
    let _cabecalhoEmpresa = `<h1 style="margin:0;font-size:24px;font-weight:700;letter-spacing:-0.5px;">${_nomeEmpresaPDF}</h1>`;
    if (_sloganPDF) _cabecalhoEmpresa += `<p style="margin:3px 0 0;font-size:11px;color:#666;">${_sloganPDF}</p>`;
    if (_modoImpressao === 'completo') {
        if (_documentoPDF) _cabecalhoEmpresa += `<p style="margin:3px 0 0;font-size:11px;color:#555;">${_documentoPDF}</p>`;
        if (_telefonePDF)  _cabecalhoEmpresa += `<p style="margin:2px 0 0;font-size:11px;color:#555;">${_telefonePDF}</p>`;
        if (_enderecoPDF)  _cabecalhoEmpresa += `<p style="margin:2px 0 0;font-size:11px;color:#555;">${_enderecoPDF}</p>`;
    }

    const conteudo = `
        <div style="padding:30px;font-family:Arial,sans-serif;color:#333;max-width:800px;margin:0 auto;">
            <div style="display:flex;justify-content:space-between;border-bottom:2px solid #999;padding-bottom:12px;margin-bottom:20px;">
                <div>${_cabecalhoEmpresa}</div>
                <div style="text-align:right;">
                    <h2 style="margin:0;font-size:18px;">PEDIDO Nº ${numeroDisplay}</h2>
                    <p style="margin:2px 0 0 0;font-size:11px;color:#666;">Data: ${dataAtual}</p>
                </div>
            </div>

            <div style="background:#f5f5f5;padding:16px 20px;border-radius:6px;margin-bottom:24px;border:1px solid #ddd;">
                ${dadosClienteHtml}
            </div>

            <table style="width:100%;border-collapse:collapse;margin-bottom:20px;font-size:13px;border:1px solid #ddd;">
                <thead>
                    <tr style="background:#e0e0e0;">
                        <th style="padding:10px;border:1px solid #ddd;width:50px;text-align:center;">Qtd</th>
                        <th style="padding:10px;border:1px solid #ddd;">Descrição</th>
                        <th style="padding:10px;border:1px solid #ddd;width:110px;text-align:right;">V. Unit.</th>
                        ${temDescontoItem ? '<th style="padding:10px;border:1px solid #ddd;width:70px;text-align:center;">Desc.%</th>' : ''}
                        <th style="padding:10px;border:1px solid #ddd;width:110px;text-align:right;">Total</th>
                    </tr>
                </thead>
                <tbody>${linhasHtml}</tbody>
            </table>

            <div style="display:flex;justify-content:flex-end;margin-bottom:40px;">
                <table style="font-size:13px;min-width:280px;">
                    <tbody>
                        ${breakdownHtml}
                        <tr style="border-top:2px solid #999;">
                            <td style="padding:10px;font-weight:bold;font-size:15px;">Total a Pagar</td>
                            <td style="padding:10px;text-align:right;font-weight:bold;font-size:18px;">${totalFormatado}</td>
                        </tr>
                    </tbody>
                </table>
            </div>

            <div style="margin-top:60px;display:flex;justify-content:space-between;">
                <div style="width:40%;border-top:1px solid #999;text-align:center;padding-top:8px;font-size:11px;color:#666;">Assinatura ${_nomeEmpresaPDF}</div>
                <div style="width:40%;border-top:1px solid #999;text-align:center;padding-top:8px;font-size:11px;color:#666;">Assinatura do Cliente</div>
            </div>
        </div>
    `;

    const opcoes = {
        margin: 10,
        filename: `Pedido_${numeroFinal}_${nomeCliente.replace(/\s+/g,'_')}.pdf`,
        image: { type: 'jpeg', quality: 0.98 },
        html2canvas: { scale: 2, logging: false },
        jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
    };

    html2pdf().set(opcoes).from(conteudo).save().then(() => {
        btn.innerHTML = textoOriginal;
        btn.disabled = false;
        Swal.fire({ icon: 'success', title: 'PDF Gerado!', timer: 2000, showConfirmButton: false });
    }).catch(err => {
        console.error("Erro no PDF:", err);
        btn.innerHTML = textoOriginal;
        btn.disabled = false;
        Swal.fire({ icon: 'error', title: 'Erro', text: 'Erro ao gerar PDF!', confirmButtonColor: '#3b82f6' });
    });
}

// ==========================================
// EXPORTAÇÕES GLOBAIS
// ==========================================
window.mostrarAba = mostrarAba;
window.formatarValorReais = formatarValorReais;
window.formatarTelefone = formatarTelefone;
window.formatarValorInput = formatarValorInput;
window.formatarDataParaExibir = formatarDataParaExibir;
window.formatarCEP = formatarCEP;
window.adicionarLinha = adicionarLinha;
window.podeEditarPedido = podeEditarPedido;
window.calcularTudo = calcularTudo;
window.gerarPDF = gerarPDF;
window.abrirCadastroCompletoProduto = abrirCadastroCompletoProduto;
window.abrirModalItens = abrirModalItens;
window.fecharModalItens = fecharModalItens;
window.adicionarProdutosSelecionados = adicionarProdutosSelecionados;
window.filtrarProdutosModal = filtrarProdutosModal;
window.selecionarProdutoModal = selecionarProdutoModal;
window.selecionarProdutoParaQuantidade = selecionarProdutoParaQuantidade;
window.quantidadeKeyDown = quantidadeKeyDown;

// ==========================================
// STUB: novoPedido (disponível antes do firebase.js carregar)
// firebase.js sobrescreve com a versão completa após inicializar
// ==========================================
window.novoPedido = function() {
    const paginaAtual = window.location.pathname.split('/').pop().replace(/\.html$/, '') || '';
    if (paginaAtual !== 'pedidos') {
        window.location.href = 'pedidos.html';
        return;
    }
    // Mostra formulário
    document.getElementById('tela-inicial-pedido')?.classList.add('hidden');
    document.getElementById('conteudo-pedido')?.classList.remove('hidden');
    // Chama inicialização completa se firebase.js já carregou
    if (typeof window._inicializarCamposPedido === 'function') {
        window._inicializarCamposPedido();
    } else {
        // Sinaliza para firebase.js inicializar quando estiver pronto
        window._novoPedidoPendente = true;
    }
};