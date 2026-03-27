// ==========================================
// firebase.js - Configuração e funções do Firebase
// ==========================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getFirestore, collection, addDoc, serverTimestamp, getDocs, getDoc, doc, updateDoc, deleteDoc, runTransaction, writeBatch, setDoc } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

// ==========================================
// EXPORTA FUNÇÕES DO FIREBASE PARA USO GLOBAL
// ==========================================
window.db = db;
window.collection = collection;
window.addDoc = addDoc;
window.serverTimestamp = serverTimestamp;
window.getDocs = getDocs;
window.doc = doc;
window.updateDoc = updateDoc;
window.deleteDoc = deleteDoc;
window.runTransaction = runTransaction;
window.writeBatch = writeBatch;

// ==========================================
// PROTEÇÃO DE ACESSO
// ==========================================
let loginVerificado = false;
window.controleEstoqueAtivo = false;

// Gera um ID único por aba — sobrevive a F5 mas não a fechar e reabrir
if (!sessionStorage.getItem('tabId')) {
    sessionStorage.setItem('tabId', Date.now().toString());
}
const _tabId = sessionStorage.getItem('tabId');

// sessionStorage sobrevive ao "continuar de onde parou" do Chrome
// Por isso usamos uma combinação: sessionStorage + flag na memória da página
// A flag _paginaCarregouNessaSessao é false ao abrir uma nova aba/janela
// mas true ao fazer F5 (a variável JS sobrevive ao reload via bfcache)
let _paginaCarregouNessaSessao = false;

// Ao carregar a página: verifica se o tabId já estava registrado no sessionStorage
// Se não estava (aba nova/navegador reaberto), força login
const _tabAtiva = sessionStorage.getItem('sessaoAtiva_' + _tabId);
if (!_tabAtiva) {
    // Aba nova ou navegador reaberto — precisa logar
    sessionStorage.clear();
}

onAuthStateChanged(auth, async (user) => {
    if (!user) {
        window.location.replace('login.html');
        return;
    }

    // Usuário Firebase existe — verifica se tem sessão local válida
    if (!sessionStorage.getItem('userLogged')) {
        // Token Firebase ainda válido mas sessão local não existe
        // (navegador foi fechado e reaberto) — força logout
        signOut(auth).then(() => window.location.replace('login.html'));
        return;
    }

    if (!loginVerificado) {
        loginVerificado = true;
        // Registra/atualiza o usuário na coleção 'usuarios' (para aparecer no painel admin)
        try {
            const userRef = doc(db, 'usuarios', user.uid);
            const userSnap = await getDoc(userRef);
            if (!userSnap.exists()) {
                await setDoc(userRef, { email: user.email, uid: user.uid, admin: false, criado_em: new Date().toISOString() });
                window.usuarioAdmin = false;
            } else {
                if (!userSnap.data().email) await setDoc(userRef, { email: user.email }, { merge: true });
                window.usuarioAdmin = userSnap.data().admin === true;
            }
        } catch(e) { console.warn('Erro ao registrar usuário:', e); window.usuarioAdmin = false; }
        carregarMemoriaBanco();
    }
});

window.fazerLogout = function() {
    sessionStorage.removeItem('userLogged');
    sessionStorage.removeItem('sessaoAtiva_' + _tabId);
    liberarTodosLocksDoUsuario(); // fire and forget — não bloqueia o logout
    signOut(auth).then(() => window.location.replace('login.html'));
};

// ==========================================
// SISTEMA DE LOCK PESSIMISTA
// ==========================================
const LOCK_TTL_MS = 10 * 60 * 1000; // 10 minutos sem atividade = lock expira
let _lockAtivo = null; // { tipo, id, lockId }
let _lockHeartbeatInterval = null;

function nomeUsuarioAtual() {
    const u = auth.currentUser;
    return u ? (u.displayName || u.email || 'Usuário') : 'Usuário';
}

async function tentarAcquireLock(tipo, id) {
    const lockId = `${tipo}_${id}`;
    const lockRef = doc(db, 'locks', lockId);

    try {
        const snap = await getDoc(lockRef);
        if (snap.exists()) {
            const data = snap.data();
            const agora = Date.now();
            const desde = data.desde?.toMillis ? data.desde.toMillis() : agora;
            // Verifica se o lock expirou
            if (agora - desde < LOCK_TTL_MS) {
                // Lock ativo de outro usuário
                const meuEmail = auth.currentUser?.email || '';
                if (data.usuarioEmail !== meuEmail) {
                    const minutos = Math.floor((agora - desde) / 60000);
                    const tempo = minutos > 0 ? `há ${minutos} min` : 'agora mesmo';
                    return { bloqueado: true, usuario: data.usuario, tempo };
                }
                // É meu próprio lock — renova e continua
            }
        }

        // Adquire ou renova o lock
        await setDoc(lockRef, {
            tipo,
            id,
            usuario: nomeUsuarioAtual(),
            usuarioEmail: auth.currentUser?.email || '',
            desde: serverTimestamp(),
            updatedAt: serverTimestamp()
        });

        _lockAtivo = { tipo, id, lockId };
        _iniciarHeartbeat(lockRef);
        return { bloqueado: false };

    } catch (e) {
        console.warn('Erro ao adquirir lock:', e);
        return { bloqueado: false }; // falha silenciosa — não bloqueia o usuário
    }
}

function _iniciarHeartbeat(lockRef) {
    if (_lockHeartbeatInterval) clearInterval(_lockHeartbeatInterval);
    _lockHeartbeatInterval = setInterval(async () => {
        try {
            if (_lockAtivo) {
                await updateDoc(lockRef, { updatedAt: serverTimestamp() });
            }
        } catch(e) { /* silencioso */ }
    }, 2 * 60 * 1000); // renova a cada 2 min
}

async function liberarLock() {
    if (!_lockAtivo) return;
    try {
        const lockRef = doc(db, 'locks', _lockAtivo.lockId);
        const snap = await getDoc(lockRef);
        if (snap.exists() && snap.data().usuarioEmail === auth.currentUser?.email) {
            await deleteDoc(lockRef);
        }
    } catch(e) { console.warn('Erro ao liberar lock:', e); }
    finally {
        _lockAtivo = null;
        if (_lockHeartbeatInterval) { clearInterval(_lockHeartbeatInterval); _lockHeartbeatInterval = null; }
    }
}

async function liberarTodosLocksDoUsuario() {
    try {
        const email = auth.currentUser?.email;
        if (!email) return;
        const snap = await getDocs(collection(db, 'locks'));
        const batch = writeBatch(db);
        snap.forEach(d => { if (d.data().usuarioEmail === email) batch.delete(d.ref); });
        await batch.commit();
    } catch(e) { console.warn('Erro ao liberar locks:', e); }
}

// Distingue F5 (reload) de fechar a aba
// pagehide com persisted=false = aba sendo fechada de verdade
// pagehide com persisted=true  = página indo pro bfcache (navegação normal)
// beforeunload sozinho não distingue os dois casos
window.addEventListener('pagehide', (e) => {
    if (!e.persisted) {
        // Aba/janela fechando de verdade — limpa sessão
        sessionStorage.removeItem('userLogged');
        sessionStorage.removeItem('sessaoAtiva_' + _tabId);
    }
    // F5 ou navegação: não limpa nada, sessão continua válida

    if (_lockAtivo) {
        try { deleteDoc(doc(db, 'locks', _lockAtivo.lockId)); } catch(e) {}
        _lockAtivo = null;
    }
});

window.tentarAcquireLock = tentarAcquireLock;
window.liberarLock = liberarLock;

// ==========================================
// MOVIMENTAÇÃO DE ESTOQUE
// ==========================================
async function descontarEstoque(itens) {
    try {
        await runTransaction(db, async (t) => {
            const refs = itens.filter(i => i.produto_id).map(i => ({ item: i, ref: doc(db, 'produtos', i.produto_id) }));
            const snaps = await Promise.all(refs.map(({ ref }) => t.get(ref)));
            refs.forEach(({ item, ref }, i) => {
                const snap = snaps[i]; if (!snap.exists()) return;
                const estoqueAtual = snap.data().estoque_atual || 0;
                const qtd = parseFloat(item.quantidade) || 0;
                const novoEstoque = window.controleEstoqueAtivo ? Math.max(0, estoqueAtual - qtd) : estoqueAtual - qtd;
                t.update(ref, { estoque_atual: novoEstoque });
            });
        });
        console.log('📦 Estoque descontado com sucesso');
    } catch(e) {
        console.error('Erro ao descontar estoque:', e);
        throw e;
    }
}

async function estornarEstoque(itens) {
    try {
        await runTransaction(db, async (t) => {
            const refs = itens.filter(i => i.produto_id).map(i => ({ item: i, ref: doc(db, 'produtos', i.produto_id) }));
            const snaps = await Promise.all(refs.map(({ ref }) => t.get(ref)));
            refs.forEach(({ item, ref }, i) => {
                const snap = snaps[i]; if (!snap.exists()) return;
                const estoqueAtual = snap.data().estoque_atual || 0;
                const qtd = parseFloat(item.quantidade) || 0;
                t.update(ref, { estoque_atual: estoqueAtual + qtd });
            });
        });
        console.log('📦 Estoque estornado com sucesso');
    } catch(e) {
        console.error('Erro ao estornar estoque:', e);
        throw e;
    }
}

// ==========================================
// VARIÁVEIS GLOBAIS
// ==========================================
window.bancoClientes = [];
window.bancoProdutos = [];
window.bancoPedidos  = [];
window.bancoParcelas = [];

const MESES_NOMES_GLOBAL = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];

// ==========================================
// FUNÇÕES DE CEP
// ==========================================
window.buscarCEPCadastro = async function() {
    const inputCEP = document.getElementById('cli-cep');
    const statusEl = document.getElementById('cep-status-cadastro');
    const cep = inputCEP.value.replace(/\D/g, '');

    if (cep.length !== 8) {
        statusEl.innerHTML = '⚠️ CEP inválido (deve ter 8 dígitos)';
        statusEl.className = 'text-xs mt-1 text-red-600';
        return;
    }

    statusEl.innerHTML = '🔍 Consultando...';
    statusEl.className = 'text-xs mt-1 text-blue-600';

    try {
        const response = await fetch(`https://viacep.com.br/ws/${cep}/json/`);
        const data = await response.json();

        if (data.erro) {
            statusEl.innerHTML = '❌ CEP não encontrado';
            statusEl.className = 'text-xs mt-1 text-red-600';
            return;
        }

        let enderecoCompleto = data.logradouro || '';
        if (data.bairro) enderecoCompleto += `, ${data.bairro}`;
        enderecoCompleto += ` - ${data.localidade}/${data.uf}`;

        document.getElementById('cli-endereco').value = enderecoCompleto;
        statusEl.innerHTML = `✅ Endereço encontrado!`;
        statusEl.className = 'text-xs mt-1 text-green-600';

    } catch (error) {
        console.error('Erro na consulta de CEP:', error);
        statusEl.innerHTML = '❌ Erro ao consultar CEP';
        statusEl.className = 'text-xs mt-1 text-red-600';
    }
};

// ==========================================
// FUNÇÃO PARA CARREGAR DADOS DO CLIENTE
// ==========================================
window.carregarDadosCliente = function() {
    const selectCliente = document.getElementById('input-cliente');
    const nomeCliente = selectCliente ? selectCliente.value : '';
    const cliente = window.bancoClientes.find(c => c.nome === nomeCliente);

    const container = document.getElementById('dados-cliente-container');
    const telefoneSpan = document.getElementById('cliente-telefone');
    const documentoSpan = document.getElementById('cliente-documento');
    const enderecoSpan = document.getElementById('cliente-endereco');
    const cepSpan = document.getElementById('cliente-cep');
    const inputEndereco = document.getElementById('input-endereco');

    if (cliente) {
        container.classList.remove('hidden');
        telefoneSpan.innerText = cliente.telefone || '-';
        documentoSpan.innerText = cliente.documento || '-';
        enderecoSpan.innerText = cliente.endereco || '-';
        cepSpan.innerText = cliente.cep || '-';
        inputEndereco.value = cliente.endereco || '';
        calcularTudo();
    } else {
        container.classList.add('hidden');
        inputEndereco.value = '';
    }
};

// ==========================================
// FUNÇÕES DE PRODUTO
// ==========================================
window.preencherProduto = function(select) {
    if (!select) return;
    const selectedOption = select.options[select.selectedIndex];
    if (!selectedOption || !selectedOption.value) return;

    const valor = selectedOption.dataset.valor;
    const fornecedor = selectedOption.dataset.forn;
    const tr = select.closest('tr');
    if (!tr) return;

    // CORRIGIDO: atualiza o produto_id na linha quando o usuário troca o produto
    tr.dataset.produtoId = selectedOption.value; // value agora é o id do produto

    const valorItem = tr.querySelector('.valor-item');
    const fornItem = tr.querySelector('.forn-item');

    if (valorItem) valorItem.value = window.formatarValorReais(parseFloat(valor));
    if (fornItem) fornItem.value = fornecedor || '';

    window.calcularTudo();
};

// ==========================================
// FUNÇÕES FINANCEIRAS
// ==========================================
window.atualizarParcelas = function() {
    const condicao = document.getElementById('select-condicao-pagamento').value;
    const divPersonalizado = document.getElementById('div-parcelas-personalizado');

    if (condicao === 'Personalizado') {
        divPersonalizado.classList.remove('hidden');
    } else {
        divPersonalizado.classList.add('hidden');
    }
};

async function gerarParcelas(pedidoId, numeroPedido, clienteNome, valorTotal, condicao, primeiroVencimento) {
    let numeroParcelas = 1;

    if (condicao === 'Vista') {
        numeroParcelas = 1;
    } else if (condicao === 'Personalizado') {
        numeroParcelas = parseInt(document.getElementById('input-parcelas')?.value) || 1;
    } else {
        numeroParcelas = parseInt(condicao.replace('x', '')) || 1;
    }

    // Busca o cliente para vincular código e ID — vínculo permanente pelo código
    const clienteObj = window.bancoClientes.find(c => c.nome === clienteNome);
    const clienteId     = clienteObj?.id     || '';
    const clienteCodigo = clienteObj?.codigo || '';

    const valorParcela = valorTotal / numeroParcelas;
    const _hj = new Date();
    const _hjISO = `${_hj.getFullYear()}-${String(_hj.getMonth()+1).padStart(2,'0')}-${String(_hj.getDate()).padStart(2,'0')}`;
    let dataVencimento = primeiroVencimento ? new Date(primeiroVencimento + 'T12:00:00') : new Date(_hjISO + 'T12:00:00');

    for (let i = 0; i < numeroParcelas; i++) {
        const vencimento = new Date(dataVencimento);
        vencimento.setMonth(vencimento.getMonth() + i);

        const parcela = {
            pedidoId:      pedidoId,      // Firebase ID (pode mudar em restore)
            numeroPedido:  numeroPedido,  // nosso ID sequencial — estável entre backups
            clienteNome:   clienteNome,   // atualizado automaticamente se o nome mudar
            clienteId:     clienteId,     // vínculo permanente pelo UID do Firebase
            clienteCodigo: clienteCodigo, // vínculo permanente pelo código sequencial
            numeroParcela: i + 1,
            totalParcelas: numeroParcelas,
            vencimento:    vencimento.toISOString().split('T')[0],
            valor:         valorParcela,
            status:        'pendente',
            dataPagamento: null,
            dataCriacao:   new Date().toISOString()
        };

        try {
            await addDoc(collection(db, "parcelas"), parcela);
        } catch (error) {
            console.error('Erro ao salvar parcela:', error);
        }
    }
}

// ==========================================
// CANCELAR PARCELAS DE UM PEDIDO
// ==========================================
async function cancelarParcelasDoPedido(pedidoId, numeroPedido) {
    try {
        // Busca o numero_sequencial do pedido se não foi passado
        if (!numeroPedido) {
            const pedido = window.bancoPedidos.find(p => p.id === pedidoId);
            numeroPedido = pedido?.numero_sequencial;
        }
        const parcelasSnap = await getDocs(collection(db, "parcelas"));
        const batch = writeBatch(db);
        let contador = 0;

        parcelasSnap.forEach(docSnap => {
            const dp = docSnap.data();
            // Cancela por Firebase ID OU por numeroPedido (estável após restore)
            const bate = dp.pedidoId === pedidoId ||
                         (numeroPedido && dp.numeroPedido === numeroPedido);
            if (bate && dp.status === 'pendente') {
                batch.update(docSnap.ref, { status: 'cancelado' });
                contador++;
            }
        });

        if (contador > 0) {
            await batch.commit();
            console.log(`${contador} parcelas canceladas`);
        }
    } catch (error) {
        console.error('Erro ao cancelar parcelas:', error);
    }
}

window.receberParcela = async function(parcelaId) {
    const result = await Swal.fire({
        title: 'Confirmar recebimento',
        text: 'Deseja marcar esta parcela como recebida?',
        icon: 'question',
        showCancelButton: true,
        confirmButtonColor: '#10b981',
        cancelButtonColor: '#6b7280',
        confirmButtonText: 'Sim, receber',
        cancelButtonText: 'Cancelar'
    });

    if (!result.isConfirmed) return;

    try {
        const parcelaRef = doc(db, "parcelas", parcelaId);
        await updateDoc(parcelaRef, {
            status: 'pago',
            dataPagamento: new Date().toISOString().split('T')[0]
        });

        await Swal.fire({
            icon: 'success',
            title: 'Recebido!',
            text: 'Parcela marcada como paga com sucesso.',
            timer: 2000,
            showConfirmButton: false
        });

        await carregarParcelasDoFirebase();
        window.carregarDadosFinanceiros();

    } catch (error) {
        console.error('Erro ao receber parcela:', error);
        Swal.fire({
            icon: 'error',
            title: 'Erro',
            text: 'Erro ao registrar pagamento!',
            confirmButtonColor: '#3b82f6'
        });
    }
};

async function carregarParcelasDoFirebase() {
    try {
        const parcelasSnap = await getDocs(collection(db, "parcelas"));
        window.bancoParcelas = parcelasSnap.docs.map(docSnap => ({
            firebaseId: docSnap.id,
            ...docSnap.data()
        }));
        console.log(`📊 ${window.bancoParcelas.length} parcelas carregadas`);
    } catch (error) {
        console.error('Erro ao carregar parcelas:', error);
        window.bancoParcelas = [];
    }
}

window.carregarDadosFinanceiros = async function() {
    await carregarParcelasDoFirebase();

    let totalReceber = 0;
    let totalVencer = 0;
    let totalAtrasado = 0;
    let totalRecebidoMes = 0;

    const hoje = new Date();
    const mesAtual = hoje.getMonth();
    const anoAtual = hoje.getFullYear();

    window.bancoParcelas.forEach(parcela => {
        // Ignora parcelas canceladas nos totais
        if (parcela.status === 'cancelado') return;

        const valor = parseFloat(parcela.valor) || 0;
        const vencimento = new Date(parcela.vencimento + 'T12:00:00');
        const diasAteVencimento = Math.ceil((vencimento - hoje) / (1000 * 60 * 60 * 24));

        if (parcela.status === 'pendente') {
            totalReceber += valor;

            if (diasAteVencimento < 0) {
                totalAtrasado += valor;
            } else if (diasAteVencimento <= 30) {
                totalVencer += valor;
            }


        } else if (parcela.status === 'pago') {
            const dataPagamento = parcela.dataPagamento ? new Date(parcela.dataPagamento + 'T12:00:00') : null;
            if (dataPagamento &&
                dataPagamento.getMonth() === mesAtual &&
                dataPagamento.getFullYear() === anoAtual) {
                totalRecebidoMes += valor;
            }
        }
    });

    document.getElementById('total-a-receber').innerText = window.formatarValorReais(totalReceber);
    document.getElementById('total-a-vencer').innerText = window.formatarValorReais(totalVencer);
    document.getElementById('total-atrasado').innerText = window.formatarValorReais(totalAtrasado);
    document.getElementById('total-recebido-mes').innerText = window.formatarValorReais(totalRecebidoMes);

    // ── Tabela de previsão de recebimento por mês/ano ──
    const MESES_NOMES = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];

    // Agrupa parcelas pendentes por mês+ano (sem limite de 12)
    const previsaoPorMes = {};
    window.bancoParcelas.forEach(parcela => {
        if (parcela.status !== 'pendente') return;
        const venc = new Date(parcela.vencimento + 'T12:00:00');
        const chave = `${venc.getFullYear()}-${String(venc.getMonth()+1).padStart(2,'0')}`;
        if (!previsaoPorMes[chave]) previsaoPorMes[chave] = { valor: 0, qtd: 0, mes: venc.getMonth(), ano: venc.getFullYear() };
        previsaoPorMes[chave].valor += parseFloat(parcela.valor) || 0;
        previsaoPorMes[chave].qtd++;
    });

    const tabelaPrevisao = document.getElementById('tabela-previsao');
    if (tabelaPrevisao) {
        const entradas = Object.entries(previsaoPorMes).sort((a,b) => a[0].localeCompare(b[0]));
        _pag.previsao.dados = entradas;
        _pag.previsao.pagina = 1;
        _renderPrevisao();
    }
};

function _renderPrevisao() {
    const tabelaPrevisao = document.getElementById('tabela-previsao');
    if (!tabelaPrevisao) return;
    const fatia = _fatiar('previsao');
    const total = _pag.previsao.dados.length;
    const hoje  = new Date();
    if (total === 0) {
        tabelaPrevisao.innerHTML = '<tr><td colspan="4" class="p-6 text-center text-gray-400">Nenhuma parcela pendente</td></tr>';
    } else {
        const hojeChave = `${hoje.getFullYear()}-${String(hoje.getMonth()+1).padStart(2,'0')}`;
        tabelaPrevisao.innerHTML = fatia.map(([chave, dado]) => {
                const atrasado  = chave < hojeChave;
                const atual     = chave === hojeChave;
                const rowCor    = atrasado ? 'bg-red-50' : (atual ? 'bg-blue-50' : '');
                const valorCor  = atrasado ? 'text-red-600 font-bold' : (atual ? 'text-blue-700 font-bold' : 'text-gray-800');
                const badge     = atrasado
                    ? '<span class="text-xs bg-red-100 text-red-600 px-2 py-0.5 rounded-full font-semibold">Atrasado</span>'
                    : atual
                    ? '<span class="text-xs bg-blue-100 text-blue-600 px-2 py-0.5 rounded-full font-semibold">Mês atual</span>'
                    : '<span class="text-xs bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full">Futuro</span>';
                return `<tr class="border-b hover:bg-gray-50 ${rowCor}">
                    <td class="p-2 font-medium">${MESES_NOMES_GLOBAL[dado.mes]} / ${dado.ano}</td>
                    <td class="p-2 text-right font-mono ${valorCor}">${window.formatarValorReais(dado.valor)}</td>
                    <td class="p-2 text-center text-gray-600">${dado.qtd} ${dado.qtd === 1 ? 'parcela' : 'parcelas'}</td>
                    <td class="p-2 text-center">${badge}</td>
                </tr>`;
            }).join('');
    }
    const ctrl = document.getElementById('pag-previsao');
    if (ctrl) ctrl.innerHTML = _pagControles(total, _pag.previsao.pagina, 'previsao');
    // Popular select de clientes no financeiro
    const selectClienteFin = document.getElementById('filtro-cliente-financeiro');
    if (selectClienteFin) {
        selectClienteFin.innerHTML = '<option value="todos">Todos os clientes</option>';
        window.bancoClientes.forEach(cl => {
            selectClienteFin.innerHTML += `<option value="${cl.nome}">${cl.nome}</option>`;
        });
    }

    window.filtrarFinanceiro();
};

window.filtrarFinanceiro = function() {
    const statusFiltro = document.getElementById('filtro-status-financeiro')?.value || 'todos';
    const clienteFiltro = document.getElementById('filtro-cliente-financeiro')?.value || 'todos';
    const busca = document.getElementById('busca-financeiro')?.value.toLowerCase() || '';

    const hoje = new Date();

    let parcelasFiltradas = window.bancoParcelas.filter(p => {
        // Por padrão, oculta canceladas a menos que o filtro seja "cancelado"
        if (statusFiltro === 'todos' && p.status === 'cancelado') return false;

        if (statusFiltro !== 'todos') {
            if (statusFiltro === 'atrasado') {
                const vencimento = new Date(p.vencimento + 'T12:00:00');
                const dias = Math.ceil((vencimento - hoje) / (1000 * 60 * 60 * 24));
                if (p.status !== 'pendente' || dias >= 0) return false;
            } else if (p.status !== statusFiltro) {
                return false;
            }
        }

        if (clienteFiltro !== 'todos' && (p.clienteNome || p.cliente) !== clienteFiltro) return false;

        if (busca) {
            const clienteMatch = (p.clienteNome || p.cliente || '').toLowerCase().includes(busca);
            const pedidoMatch = p.pedidoId?.toLowerCase().includes(busca);
            if (!clienteMatch && !pedidoMatch) return false;
        }

        return true;
    });

    parcelasFiltradas.sort((a, b) => new Date(a.vencimento) - new Date(b.vencimento));

    _pag.financeiro.dados = parcelasFiltradas;
    _pag.financeiro.pagina = 1;
    _renderFinanceiro();
};

function _renderFinanceiro() {
    const fatia = _fatiar('financeiro');
    const total = _pag.financeiro.dados.length;
    const hoje  = new Date();
    let html = '';

    if (total === 0) {
        html = '<tr><td colspan="8" class="p-4 text-center text-gray-500">Nenhuma parcela encontrada</td></tr>';
    } else {
        fatia.forEach(p => {
            const vencimento = new Date(p.vencimento + 'T12:00:00');
            const diasAteVencimento = Math.ceil((vencimento - hoje) / (1000 * 60 * 60 * 24));

            let statusClass = '';
            let statusText = '';
            let diasTexto = '';
            let diasClass = '';
            let linhaClass = '';

            if (p.status === 'cancelado') {
                statusClass = 'bg-gray-400';
                statusText = 'Cancelado';
                diasTexto = '-';
                diasClass = 'text-gray-400';
                linhaClass = 'opacity-60';
            } else if (p.status === 'pago') {
                statusClass = 'badge-pago';
                statusText = 'Pago';
                diasTexto = 'Pago';
                diasClass = 'text-green-600';
                linhaClass = 'status-pago';
            } else if (diasAteVencimento < 0) {
                statusClass = 'badge-atrasado';
                statusText = 'Atrasado';
                diasTexto = `${Math.abs(diasAteVencimento)} dias atrasado`;
                diasClass = 'text-red-600 font-bold';
                linhaClass = 'status-atrasado';
            } else if (diasAteVencimento === 0) {
                statusClass = 'badge-pendente';
                statusText = 'Vence hoje';
                diasTexto = 'Vence hoje';
                diasClass = 'text-orange-600 font-bold';
                linhaClass = 'status-pendente';
            } else {
                statusClass = 'badge-pendente';
                statusText = 'A Receber';
                diasTexto = `Faltam ${diasAteVencimento} dias`;
                diasClass = 'text-yellow-600';
                linhaClass = 'status-pendente';
            }

            const pedido = window.bancoPedidos.find(ped => ped.id === p.pedidoId);
            // Usa numeroPedido da própria parcela (estável entre backups)
            // Fallback: busca no bancoPedidos pelo Firebase ID
            const numSeqParcela = p.numeroPedido || pedido?.numero_sequencial;
            const numeroPedido = numSeqParcela
                ? `#${numSeqParcela.toString().padStart(3, '0')}`
                : p.pedidoId?.substring(0, 6) || '---';

            const parcelaTexto = p.totalParcelas > 1 ? `${p.numeroParcela}/${p.totalParcelas}` : 'Única';

            html += `
            <tr class="border-b hover:bg-gray-50 ${linhaClass}">
                <td class="p-2 border">${p.clienteNome || p.cliente || '-'}</td>
                <td class="p-2 border font-bold">${numeroPedido}</td>
                <td class="p-2 border">${parcelaTexto}</td>
                <td class="p-2 border">${window.formatarDataParaExibir(p.vencimento)}</td>
                <td class="p-2 border">${window.formatarValorReais(p.valor)}</td>
                <td class="p-2 border">
                    <span class="px-2 py-1 rounded-full text-xs font-medium text-white ${statusClass}">
                        ${statusText}
                    </span>
                </td>
                <td class="p-2 border ${diasClass}">${diasTexto}</td>
                <td class="p-2 border">
                    ${p.status === 'pendente' ? `
                        <button onclick="window.receberParcela('${p.firebaseId}')" class="text-green-600 hover:text-green-800 mr-2" title="Receber parcela">
                            💰 Receber
                        </button>
                    ` : ''}
                    ${p.status === 'pago' ? '✅' : ''}
                    ${p.status === 'cancelado' ? '🚫' : ''}
                    <button onclick="window.verDetalhesParcela(${p.numeroPedido || "'" + p.pedidoId + "'"})" class="text-blue-600 hover:text-blue-800" title="Ver pedido">
                        👁️
                    </button>
                </td>
            </tr>`;
        });
    }

    const tblFin = document.getElementById('tabela-financeiro');
    if (tblFin) tblFin.innerHTML = html;
    const ctrl = document.getElementById('pag-financeiro');
    if (ctrl) ctrl.innerHTML = _pagControles(total, _pag.financeiro.pagina, 'financeiro');
}

window.verDetalhesParcela = function(pedidoIdOuNumero) {
    // Aceita Firebase ID ou numero_sequencial (mais estável entre backups)
    let pedido = window.bancoPedidos.find(p => p.id === pedidoIdOuNumero);
    if (!pedido && !isNaN(pedidoIdOuNumero)) {
        pedido = window.bancoPedidos.find(p => p.numero_sequencial === Number(pedidoIdOuNumero));
    }
    const firebaseId = pedido?.id || pedidoIdOuNumero;
    if (pedido) {
        window.abrirPedidoParaEdicao(firebaseId);
    } else {
        Swal.fire({
            icon: 'error',
            title: 'Erro',
            text: 'Pedido não encontrado!',
            confirmButtonColor: '#3b82f6'
        });
    }
};

// ==========================================
// FUNÇÕES DE STATUS
// ==========================================

// Configuração centralizada de status
const STATUS_CONFIG = {
    'Orçamento':               { btnId: 'status-orcamento',  cor: 'border-yellow-500 bg-yellow-50 text-yellow-700', progresso: { width: '10%',  cor: 'bg-yellow-500', texto: 'Orçamento' } },
    'Produção':                { btnId: 'status-producao',   cor: 'border-blue-500 bg-blue-50 text-blue-700',       progresso: { width: '50%',  cor: 'bg-blue-500',   texto: 'Em produção' } },
    'Em Entrega':              { btnId: 'status-entrega',    cor: 'border-orange-500 bg-orange-50 text-orange-700', progresso: { width: '75%',  cor: 'bg-orange-500', texto: 'Saiu para entrega' } },
    'Entregue':                { btnId: 'status-entregue',   cor: 'border-green-500 bg-green-50 text-green-700',    progresso: { width: '100%', cor: 'bg-green-500',  texto: 'Entregue' } },
    'Pedido Cancelado':        { btnId: 'status-cancelado',  cor: 'border-red-500 bg-red-50 text-red-700',          progresso: { width: '100%', cor: 'bg-red-500',    texto: 'Pedido cancelado' } },
    'Orçamento Não Aprovado':  { btnId: 'status-reprovado',  cor: 'border-red-400 bg-red-50 text-red-600',          progresso: { width: '10%',  cor: 'bg-red-400',    texto: 'Orçamento não aprovado' } }
};

// Status que bloqueiam edição dos campos do pedido
const STATUS_BLOQUEADOS = ['Produção', 'Em Entrega', 'Entregue'];

// Status que encerram o pedido (não geram/mantêm parcelas)
const STATUS_ENCERRADOS = ['Pedido Cancelado', 'Orçamento Não Aprovado'];

// Transições permitidas de cada status
const FLUXO_PERMITIDO = {
    'Orçamento':              ['Produção', 'Pedido Cancelado', 'Orçamento Não Aprovado'],
    'Produção':               ['Em Entrega', 'Pedido Cancelado'],
    'Em Entrega':             ['Entregue', 'Pedido Cancelado'],
    'Entregue':               [],
    'Pedido Cancelado':       [],
    'Orçamento Não Aprovado': []
};

window.selecionarStatus = async function(novoStatus) {
    const selectStatus = document.getElementById('select-status');
    const statusAtual = selectStatus ? selectStatus.value : 'Orçamento';

    if (statusAtual === novoStatus) return;

    const transicoesPermitidas = FLUXO_PERMITIDO[statusAtual] || [];

    if (!transicoesPermitidas.includes(novoStatus)) {
        let mensagem = '';
        if (['Entregue', 'Pedido Cancelado', 'Orçamento Não Aprovado'].includes(statusAtual)) {
            mensagem = `❌ O status "${statusAtual}" é final e não pode ser alterado!`;
        } else {
            mensagem = `❌ Não é possível ir de "${statusAtual}" para "${novoStatus}" diretamente.`;
        }

        Swal.fire({
            icon: 'error',
            title: 'Transição inválida',
            text: mensagem,
            confirmButtonColor: '#3b82f6'
        });

        atualizarBotoesStatus(statusAtual);
        return;
    }

    // ── BUG FIX 1: bloqueia Produção se pedido não foi salvo ou não tem itens ──
    if (novoStatus === 'Produção') {
        const pedidoIdAtual = document.getElementById('pedido-id-atual')?.value || '';
        if (!pedidoIdAtual) {
            Swal.fire({
                icon: 'warning',
                title: 'Pedido não salvo',
                html: 'Salve o pedido antes de enviá-lo para Produção.',
                confirmButtonColor: '#3b82f6'
            });
            atualizarBotoesStatus(statusAtual);
            return;
        }
        const linhas = document.querySelectorAll('#tabela-itens tr[data-produto-id]');
        const temItens = Array.from(linhas).some(tr => tr.querySelector('.produto-select')?.value);
        if (!temItens) {
            Swal.fire({
                icon: 'warning',
                title: 'Pedido sem itens',
                html: 'Adicione pelo menos um produto antes de enviar para Produção.',
                confirmButtonColor: '#3b82f6'
            });
            atualizarBotoesStatus(statusAtual);
            return;
        }
    }

    // ── BUG FIX 2: confirmação reforçada para cancelar pedido em produção ──
    if (novoStatus === 'Pedido Cancelado' && ['Produção', 'Em Entrega'].includes(statusAtual)) {
        const nomeCliente = document.getElementById('input-cliente')?.value || '';
        const parcelas = window.bancoParcelas.filter(p =>
            p.pedidoId === document.getElementById('pedido-id-atual')?.value && p.status === 'pendente'
        );
        const totalParcelas = parcelas.reduce((s, p) => s + (parseFloat(p.valor) || 0), 0);
        const fmt = v => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

        const result = await Swal.fire({
            icon: 'error',
            title: '🚨 Pedido em Produção!',
            html: `
                <div style="text-align:left;font-size:14px;line-height:2">
                    <b>Cliente:</b> ${nomeCliente}<br>
                    <b>Status atual:</b> <span style="color:#dc2626;font-weight:bold">${statusAtual}</span><br>
                    ${parcelas.length > 0 ? `<b>Parcelas pendentes:</b> <span style="color:#dc2626;font-weight:bold">${parcelas.length} parcela(s) — ${fmt(totalParcelas)}</span><br>` : ''}
                    <hr style="margin:8px 0">
                    <span style="color:#dc2626">⚠️ Cancelar irá <b>cancelar todas as parcelas financeiras</b> pendentes deste pedido.</span><br><br>
                    <b>Tem certeza absoluta que deseja cancelar?</b>
                </div>`,
            showCancelButton: true,
            confirmButtonColor: '#dc2626',
            cancelButtonColor: '#6b7280',
            confirmButtonText: '🚨 Sim, cancelar pedido',
            cancelButtonText: 'Não, manter em produção',
            reverseButtons: true
        });

        if (!result.isConfirmed) {
            atualizarBotoesStatus(statusAtual);
            return;
        }
    }

    // ── VERIFICAÇÃO DE LIMITE DE CRÉDITO ao entrar em Produção ──────────
    if (novoStatus === 'Produção') {
        const nomeCliente = document.getElementById('input-cliente')?.value || '';
        const clienteObj = window.bancoClientes.find(c => c.nome === nomeCliente);
        const limite = parseFloat(clienteObj?.limite) || 0;

        if (limite > 0) {
            const pedidoIdAtual = document.getElementById('pedido-id-atual')?.value || '';
            const totalAtual = parseFloat(
                document.getElementById('btn-gerar-pdf')?.getAttribute('data-total')?.replace(',', '.') || '0'
            ) || 0;

            // Soma pedidos ativos do cliente (exceto o atual)
            const ESTADOS_ATIVOS = ['Produção', 'Em Entrega'];
            const totalEmAberto = window.bancoPedidos
                .filter(p => p.cliente_id === clienteObj?.id && ESTADOS_ATIVOS.includes(p.status) && p.id !== pedidoIdAtual)
                .reduce((sum, p) => sum + (parseFloat(p.valor_total) || 0), 0);

            const totalComEste = totalEmAberto + totalAtual;

            if (totalComEste > limite) {
                const fmt = v => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
                const result = await Swal.fire({
                    icon: 'warning',
                    title: '⚠️ Limite de crédito excedido',
                    html: `
                        <div style="text-align:left;font-size:14px;line-height:1.8">
                            <b>Cliente:</b> ${clienteObj.nome}<br>
                            <b>Limite:</b> <span style="color:#16a34a">${fmt(limite)}</span><br>
                            <b>Em aberto:</b> <span style="color:#dc2626">${fmt(totalEmAberto)}</span><br>
                            <b>Este pedido:</b> <span style="color:#2563eb">${fmt(totalAtual)}</span><br>
                            <hr style="margin:8px 0">
                            <b>Total com este pedido:</b> <span style="color:#dc2626;font-weight:bold">${fmt(totalComEste)}</span><br>
                            <b>Limite disponível:</b> <span style="color:#dc2626;font-weight:bold">${fmt(Math.max(0, limite - totalEmAberto))}</span>
                        </div>`,
                    showCancelButton: true,
                    confirmButtonColor: '#dc2626',
                    cancelButtonColor: '#6b7280',
                    confirmButtonText: '⚠️ Produzir mesmo assim',
                    cancelButtonText: 'Cancelar'
                });

                if (!result.isConfirmed) {
                    atualizarBotoesStatus(statusAtual);
                    return;
                }
            }
        }
    }
    // ─────────────────────────────────────────────────────────────────────

    if (selectStatus) selectStatus.value = novoStatus;
    atualizarBotoesStatus(novoStatus);
    atualizarBarraProgresso(novoStatus);

    // Orçamento: cliente bloqueado, resto livre | qualquer outro status: tudo bloqueado
    _aplicarBloqueioStatus(novoStatus);

    const clienteSelect = document.getElementById('input-cliente');
    const cliente = clienteSelect ? clienteSelect.value : '';

    if (!cliente) {
        Swal.fire({
            icon: 'warning',
            title: 'Cliente não selecionado',
            text: 'Selecione um cliente antes de mudar o status!',
            confirmButtonColor: '#3b82f6'
        });
        return;
    }

    Swal.fire({
        title: 'Salvar pedido?',
        text: `Status alterado para "${novoStatus}". Deseja salvar o pedido agora?`,
        icon: 'question',
        showCancelButton: true,
        confirmButtonColor: '#3b82f6',
        cancelButtonColor: '#6b7280',
        confirmButtonText: 'Sim, salvar',
        cancelButtonText: 'Não'
    }).then((result) => {
        if (result.isConfirmed) {
            salvarPedidoAtual();
        }
    });
};

// nivel: false = libera tudo | 'cliente' = só trava o cliente (orçamento) | 'tudo' = trava tudo
function bloquearCampos(nivel) {
    const camposOrcamento = [
        'input-km', 'input-litro', 'input-consumo', 'input-pedagio',
        'input-desconto', 'input-acrescimo', 'input-motivo-acrescimo',
        'select-pagamento', 'select-condicao-pagamento', 'input-parcelas',
        'input-primeiro-vencimento', 'input-previsao'
    ];

    const _set = (id, bloquear) => {
        const el = document.getElementById(id);
        if (!el) return;
        if (bloquear) {
            el.setAttribute('disabled', 'disabled');
            el.classList.add('bg-gray-100', 'cursor-not-allowed');
        } else {
            el.removeAttribute('disabled');
            el.classList.remove('bg-gray-100', 'cursor-not-allowed');
        }
    };

    const _setBtn = (el, bloquear) => {
        if (!el) return;
        if (bloquear) {
            el.setAttribute('disabled', 'disabled');
            el.classList.add('opacity-50', 'cursor-not-allowed');
        } else {
            el.removeAttribute('disabled');
            el.classList.remove('opacity-50', 'cursor-not-allowed');
        }
    };

    const _bloqueioSelect2Cliente = (bloquear) => {
        if ($.fn.select2) {
            const container = $('#input-cliente').next('.select2-container').find('.select2-selection');
            if (bloquear) {
                container.css({ 'pointer-events': 'none', 'background-color': '#f3f4f6', 'cursor': 'not-allowed' });
            } else {
                container.css({ 'pointer-events': '', 'background-color': '', 'cursor': '' });
            }
        }
    };

    if (nivel === false) {
        // Libera absolutamente tudo
        _set('input-cliente', false); _bloqueioSelect2Cliente(false);
        camposOrcamento.forEach(id => _set(id, false));
        document.querySelectorAll('#tabela-itens input, #tabela-itens select').forEach(el => {
            el.removeAttribute('disabled'); el.classList.remove('bg-gray-100', 'cursor-not-allowed');
        });
        document.querySelectorAll('#tabela-itens .select2-container').forEach(el => {
            el.style.pointerEvents = ''; el.style.opacity = ''; el.style.cursor = '';
        });
        document.querySelectorAll('#tabela-itens button').forEach(el => _setBtn(el, false));
        _setBtn(document.querySelector('#linha-adicionar button'), false);

    } else if (nivel === 'cliente') {
        // Orçamento: cliente fixo, todo o resto editável
        _set('input-cliente', true); _bloqueioSelect2Cliente(true);
        camposOrcamento.forEach(id => _set(id, false));
        document.querySelectorAll('#tabela-itens input, #tabela-itens select').forEach(el => {
            el.removeAttribute('disabled'); el.classList.remove('bg-gray-100', 'cursor-not-allowed');
        });
        document.querySelectorAll('#tabela-itens button').forEach(el => _setBtn(el, false));
        _setBtn(document.querySelector('#linha-adicionar button'), false);

    } else if (nivel === 'tudo') {
        // Pós-orçamento: trava tudo sem exceção
        _set('input-cliente', true); _bloqueioSelect2Cliente(true);
        camposOrcamento.forEach(id => _set(id, true));
        document.querySelectorAll('#tabela-itens input, #tabela-itens select').forEach(el => {
            el.setAttribute('disabled', 'disabled'); el.classList.add('bg-gray-100', 'cursor-not-allowed');
        });
        // Desabilita wrappers do Select2 nos itens
        document.querySelectorAll('#tabela-itens .select2-container').forEach(el => {
            el.style.pointerEvents = 'none'; el.style.opacity = '0.6'; el.style.cursor = 'not-allowed';
        });
        document.querySelectorAll('#tabela-itens button').forEach(el => _setBtn(el, true));
        _setBtn(document.querySelector('#linha-adicionar button'), true);
    }

    // btn-salvar é controlado por _aplicarBloqueioStatus, não aqui
}

// Aplica o nível correto de bloqueio conforme o status e atualiza o aviso visual
function _aplicarBloqueioStatus(status) {
    const aviso  = document.getElementById('aviso-bloqueio');
    const spanSt = document.getElementById('status-bloqueio');
    const btnSalvar   = document.getElementById('btn-salvar');
    const btnAdicionar = document.getElementById('btn-adicionar-itens');

    const _bloquearBtn = (btn, bloquear) => {
        if (!btn) return;
        if (bloquear) {
            btn.setAttribute('disabled', 'disabled');
            btn.classList.add('opacity-50', 'cursor-not-allowed');
            btn.classList.remove('hover:bg-blue-700', 'hover:bg-green-700');
        } else {
            btn.removeAttribute('disabled');
            btn.classList.remove('opacity-50', 'cursor-not-allowed');
        }
    };

    const btnReabrir = document.getElementById('btn-reabrir-orcamento');

    if (status === 'Orçamento') {
        bloquearCampos('cliente');
        _bloquearBtn(btnAdicionar, false);
        _bloquearBtn(btnSalvar, false);
        if (aviso) aviso.classList.add('hidden');
        if (btnReabrir) btnReabrir.classList.add('hidden');
    } else {
        bloquearCampos('tudo');
        _bloquearBtn(btnAdicionar, true);
        _bloquearBtn(btnSalvar, true);
        if (aviso && spanSt) {
            spanSt.innerText = status;
            aviso.classList.remove('hidden');
        }
        // Mostra botão de reabrir apenas para admins e apenas em statuses reversíveis
        if (btnReabrir) {
            const statusBloqueadoDefinitivo = ['Pedido Cancelado', 'Orçamento Não Aprovado'].includes(status);
            if (window.usuarioAdmin && !statusBloqueadoDefinitivo) {
                btnReabrir.classList.remove('hidden');
            } else {
                btnReabrir.classList.add('hidden');
            }
        }
    }
}

function atualizarBotoesStatus(status) {
    // Remove destaque de todos os botões
    Object.values(STATUS_CONFIG).forEach(cfg => {
        const btn = document.getElementById(cfg.btnId);
        if (!btn) return;
        // Remove todas as classes de cor possíveis
        btn.classList.remove(
            'border-yellow-500', 'bg-yellow-50', 'text-yellow-700',
            'border-blue-500', 'bg-blue-50', 'text-blue-700',
            'border-orange-500', 'bg-orange-50', 'text-orange-700',
            'border-green-500', 'bg-green-50', 'text-green-700',
            'border-red-500', 'bg-red-50', 'text-red-700',
            'border-red-400', 'text-red-600'
        );
        btn.classList.add('border-gray-200', 'bg-gray-50', 'text-gray-700');
    });

    // Destaca o botão do status atual
    const cfg = STATUS_CONFIG[status];
    if (cfg) {
        const btn = document.getElementById(cfg.btnId);
        if (btn) {
            btn.classList.remove('border-gray-200', 'bg-gray-50', 'text-gray-700');
            cfg.cor.split(' ').forEach(cls => btn.classList.add(cls));
        }
    }
}

function atualizarBarraProgresso(status) {
    const barra = document.getElementById('progress-bar');
    const label = document.getElementById('status-label');
    if (!barra || !label) return;

    const cfg = STATUS_CONFIG[status]?.progresso || STATUS_CONFIG['Orçamento'].progresso;

    barra.classList.remove('bg-yellow-500', 'bg-blue-500', 'bg-orange-500', 'bg-green-500', 'bg-red-500', 'bg-red-400');
    barra.classList.add(cfg.cor);
    barra.style.width = cfg.width;
    label.innerHTML = `Status: ${status} - ${cfg.texto}`;
}

function gerarBadgeStatus(status) {
    const config = {
        'Orçamento':              { cor: 'bg-yellow-100 text-yellow-800 border-yellow-300', icone: '📋' },
        'Produção':               { cor: 'bg-blue-100 text-blue-800 border-blue-300',       icone: '🔧' },
        'Em Entrega':             { cor: 'bg-orange-100 text-orange-800 border-orange-300', icone: '🚚' },
        'Entregue':               { cor: 'bg-green-100 text-green-800 border-green-300',    icone: '✅' },
        'Pedido Cancelado':       { cor: 'bg-red-100 text-red-800 border-red-300',          icone: '🚫' },
        'Orçamento Não Aprovado': { cor: 'bg-red-50 text-red-600 border-red-200',           icone: '📉' }
    };
    const cfg = config[status] || { cor: 'bg-gray-100 text-gray-800 border-gray-300', icone: '📦' };
    return `<span class="inline-flex items-center gap-1 px-3 py-1 rounded-full text-xs font-medium border ${cfg.cor}">${cfg.icone} ${status}</span>`;
}

// ==========================================
// FUNÇÕES DO BANCO DE DADOS
// ==========================================
async function obterProximoNumeroPedido() {
    const ref = doc(db, "configuracoes", "contador_pedidos");
    return await runTransaction(db, async (t) => {
        const snap = await t.get(ref);
        const n = snap.exists() ? snap.data().ultimo_numero + 1 : 1;
        t.set(ref, { ultimo_numero: n });
        return n;
    });
}

async function carregarMemoriaBanco() {
    if (!auth.currentUser) {
        console.warn('⚠️ carregarMemoriaBanco ignorado: usuário não autenticado');
        return;
    }
    try {
        console.log('📥 Carregando clientes...');
        const cliSnap = await getDocs(collection(db, "clientes"));
        window.bancoClientes = cliSnap.docs.map(d => ({ id: d.id, ...d.data() }));

        console.log('📥 Carregando produtos...');
        const prodSnap = await getDocs(collection(db, "produtos"));
        window.bancoProdutos = prodSnap.docs.map(d => ({ id: d.id, ...d.data() }));

        // Migração silenciosa: clientes sem codigo recebem um agora
        const clientesSemCodigo = cliSnap.docs.filter(d => !d.data().codigo);
        if (clientesSemCodigo.length > 0) {
            let maxCodigo = 0;
            cliSnap.docs.forEach(d => {
                const num = parseInt(d.data().codigo);
                if (!isNaN(num) && num > maxCodigo) maxCodigo = num;
            });
            const batchMig = writeBatch(db);
            clientesSemCodigo.forEach(d => {
                maxCodigo++;
                batchMig.update(d.ref, { codigo: maxCodigo.toString().padStart(4, '0') });
            });
            await batchMig.commit();
            console.log(`✅ ${clientesSemCodigo.length} cliente(s) sem código receberam códigos sequenciais.`);
        }

        console.log('📥 Carregando pedidos...');
        const pedSnap = await getDocs(collection(db, "pedidos"));
        window.bancoPedidos = pedSnap.docs.map(d => ({ id: d.id, ...d.data() }));

        console.log('📥 Carregando parcelas...');
        await carregarParcelasDoFirebase();

        // Carrega configurações de frete e aplica nos inputs
        try {
            const cfgSnap = await getDoc(doc(db, 'configuracoes', 'frete'));
            if (cfgSnap.exists()) {
                const cfg = cfgSnap.data();
                const elLitro   = document.getElementById('input-litro');
                const elConsumo = document.getElementById('input-consumo');
                if (elLitro   && cfg.litro)   elLitro.value   = cfg.litro;
                if (elConsumo && cfg.consumo) elConsumo.value = cfg.consumo;
                console.log('⚙️ Configs de frete carregadas:', cfg);
            }
        } catch(e) { console.warn('Configs de frete não encontradas, usando padrão.'); }

        window.bancoPedidos.sort((a, b) => {
    const toMs = d => {
        if (!d) return 0;
        if (d.seconds) return d.seconds * 1000;
        const s = String(d).trim();
        if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) {
            const [dd, mm, yyyy] = s.split('/');
            return new Date(`${yyyy}-${mm}-${dd}`).getTime();
        }
        return new Date(s).getTime() || 0;
    };
    return toMs(b.data_criacao) - toMs(a.data_criacao);
});

        renderizarTudo();

        // Verifica sessionStorage para abrir pedido direto (navegação entre páginas)
        const pedidoParam = sessionStorage.getItem('abrirPedido');
        if (pedidoParam && document.getElementById('tabela-itens')) {
            sessionStorage.removeItem('abrirPedido');
            window.abrirPedidoParaEdicao(pedidoParam);
        }

        // Carrega financeiro automaticamente se estiver na página financeiro
        if (document.getElementById('aba-financeiro') && typeof window.carregarDadosFinanceiros === 'function') {
            window.carregarDadosFinanceiros();
        }

        // Carrega controle de estoque
        try {
            const cfgSistema = await getDoc(doc(db, 'configuracoes', 'sistema'));
            window.controleEstoqueAtivo = cfgSistema.exists() ? (cfgSistema.data().controle_estoque ?? false) : false;
        } catch(e) { window.controleEstoqueAtivo = false; }

        // Carrega identidade da empresa e salva em localStorage
        try {
            const empSnap = await getDoc(doc(db, 'configuracoes', 'empresa'));
            const empConfig = empSnap.exists() ? empSnap.data() : {};
            localStorage.setItem('empresaConfig', JSON.stringify(empConfig));
            document.dispatchEvent(new CustomEvent('empresaConfigCarregada', { detail: empConfig }));
        } catch(e) { console.warn('Config empresa não encontrada.'); }

        // Autocorreção do contador de pedidos
        try {
            const contRef  = doc(db, 'configuracoes', 'contador_pedidos');
            const contSnap = await getDoc(contRef);
            const contAtual = contSnap.exists() ? (contSnap.data().ultimo_numero ?? 0) : 0;
            const maiorNum  = window.bancoPedidos.reduce((mx, p) => Math.max(mx, parseInt(p.numero_sequencial)||0), 0);
            if (maiorNum > contAtual) { await setDoc(contRef, { ultimo_numero: maiorNum }); console.log(`🔢 Contador corrigido: ${contAtual} → ${maiorNum}`); }
        } catch(e) {}

    } catch (e) {
        console.error("Erro ao carregar:", e);
        Swal.fire({
            icon: 'error',
            title: 'Erro',
            text: 'Erro ao carregar dados do banco!',
            confirmButtonColor: '#3b82f6'
        });
    }
}


// ==========================================
// SISTEMA DE PAGINAÇÃO CENTRALIZADO
// ==========================================
const _pag = {
    pedidos:    { pagina: 1, dados: [] },
    clientes:   { pagina: 1, dados: [] },
    produtos:   { pagina: 1, dados: [] },
    financeiro: { pagina: 1, dados: [] },
    previsao:   { pagina: 1, dados: [] },
};
const POR_PAGINA = 10;

function _pagControles(total, pagAtual, chave, idContainer) {
    const totalPags = Math.max(1, Math.ceil(total / POR_PAGINA));
    if (totalPags <= 1) return '';
    let btns = '';
    // Anterior
    btns += `<button onclick="_irPagina('${chave}',${pagAtual - 1})"
        class="px-2 py-1 rounded border text-sm ${pagAtual <= 1 ? 'text-gray-300 border-gray-200 cursor-not-allowed' : 'hover:bg-gray-100 border-gray-300'}"
        ${pagAtual <= 1 ? 'disabled' : ''}>‹</button>`;
    // Números
    for (let i = 1; i <= totalPags; i++) {
        const ativo = i === pagAtual;
        btns += `<button onclick="_irPagina('${chave}',${i})"
            class="px-3 py-1 rounded border text-sm font-medium ${ativo ? 'bg-blue-600 text-white border-blue-600' : 'hover:bg-gray-100 border-gray-300 text-gray-700'}">${i}</button>`;
    }
    // Próxima
    btns += `<button onclick="_irPagina('${chave}',${pagAtual + 1})"
        class="px-2 py-1 rounded border text-sm ${pagAtual >= totalPags ? 'text-gray-300 border-gray-200 cursor-not-allowed' : 'hover:bg-gray-100 border-gray-300'}"
        ${pagAtual >= totalPags ? 'disabled' : ''}>›</button>`;

    const inicio = (pagAtual - 1) * POR_PAGINA + 1;
    const fim    = Math.min(pagAtual * POR_PAGINA, total);
    return `<div class="flex items-center justify-between mt-3 pt-3 border-t border-gray-100">
        <span class="text-xs text-gray-400">${inicio}–${fim} de ${total}</span>
        <div class="flex gap-1">${btns}</div>
    </div>`;
}

window._irPagina = function(chave, pagina) {
    const estado = _pag[chave];
    const total  = Math.ceil(estado.dados.length / POR_PAGINA);
    if (pagina < 1 || pagina > total) return;
    estado.pagina = pagina;
    _reRenderizar(chave);
};

function _fatiar(chave) {
    const { pagina, dados } = _pag[chave];
    const inicio = (pagina - 1) * POR_PAGINA;
    return dados.slice(inicio, inicio + POR_PAGINA);
}

function _reRenderizar(chave) {
    if      (chave === 'pedidos')    _renderPedidos();
    else if (chave === 'clientes')   _renderClientes();
    else if (chave === 'produtos')   _renderProdutos();
    else if (chave === 'financeiro') _renderFinanceiro();
    else if (chave === 'previsao')   _renderPrevisao();
}

function renderizarTudo() {
    _pag.pedidos.dados  = window.bancoPedidos;
    _pag.clientes.dados = window.bancoClientes;
    _pag.produtos.dados = window.bancoProdutos;
    _pag.pedidos.pagina = _pag.clientes.pagina = _pag.produtos.pagina = 1;

    if (document.getElementById('wrap-pedidos-pag') || document.getElementById('tabela-pedidos')) _renderPedidos();
    if (document.getElementById('wrap-clientes-pag') || document.getElementById('lista-clientes')) _renderClientes();
    if (document.getElementById('lista-produtos')) _renderProdutos();

    // Select cliente no pedido
    const selectCliente = document.getElementById('input-cliente');
    if (selectCliente) {
        const currentValue = selectCliente.value;
        selectCliente.innerHTML = '<option value="">Selecione um cliente</option>';
        window.bancoClientes.forEach(cl => {
            selectCliente.innerHTML += `<option value="${cl.nome}">${cl.codigo ? '[' + cl.codigo + '] ' : ''}${cl.nome}</option>`;
        });
        if (currentValue) selectCliente.value = currentValue;
        if ($.fn.select2) $(selectCliente).select2({ placeholder: "Busque um cliente...", allowClear: true, width: '100%' });
    }

    const tbody = document.getElementById('tabela-itens');
    const conteudoPedido = document.getElementById('conteudo-pedido');
    const pedidoAtivo = conteudoPedido && !conteudoPedido.classList.contains('hidden');

    if (tbody && tbody.children.length === 0 && !pedidoAtivo) {
        // Página carregando sem pedido ativo — mantém tela inicial, não inicializa
    } else if (tbody && tbody.children.length === 0) {
        // Pedido ativo mas sem itens — re-inicializa campos
        _inicializarCamposPedido();
    } else {
        document.querySelectorAll('#tabela-itens .produto-select').forEach(select => {
            if ($.fn.select2) $(select).select2({ placeholder: "Busque um produto...", allowClear: true, width: '100%' });
        });
    }
}

// Formata data_criacao aceitando: Firestore Timestamp, ISO string, "DD/MM/YYYY", ou nulo
function _formatarDataPedido(dc) {
    if (!dc) return '-';
    try {
        if (dc.seconds) return new Date(dc.seconds * 1000).toLocaleDateString('pt-BR');
        const s = String(dc).trim();
        if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) return s; // já está em BR
        const d = new Date(s);
        if (!isNaN(d)) return d.toLocaleDateString('pt-BR');
    } catch(e) {}
    return '-';
}

// ── render individual pedidos ──
function _renderPedidos() {
    const fatia = _fatiar('pedidos');
    const total = _pag.pedidos.dados.length;
    const html  = fatia.map(p => `
        <tr class="border-b text-sm hover:bg-gray-50">
            <td class="p-2 border-r font-bold">#${p.numero_sequencial?.toString().padStart(3,'0') || 'S/N'}</td>
            <td class="p-2 border-r">${_formatarDataPedido(p.data_criacao)}</td>
            <td class="p-2 border-r font-mono text-xs text-gray-500">${p.cliente_codigo || window.bancoClientes.find(cl=>cl.id===p.cliente_id)?.codigo || '---'}</td>
            <td class="p-2 border-r">${(p.cliente_codigo ? window.bancoClientes.find(cl=>cl.codigo===p.cliente_codigo)?.nome : null) || window.bancoClientes.find(cl=>cl.id===p.cliente_id)?.nome || p.cliente_nome}</td>
            <td class="p-2 border-r">${gerarBadgeStatus(p.status)}</td>
            <td class="p-2 border-r">${window.formatarValorReais(p.valor_total)}</td>
            <td class="p-2 border-r">${p.condicao_pagamento||'Vista'}</td>
            <td class="p-2 text-center"><button onclick="window.abrirPedidoParaEdicao('${p.id}')" class="btn btn-dark btn-sm">👁️ Abrir</button></td>
        </tr>`).join('') || '<tr><td colspan="8" class="p-4 text-center text-gray-500">Nenhum pedido encontrado</td></tr>';

    const wrap = document.getElementById('wrap-pedidos-pag');
    if (wrap) wrap.innerHTML = `<table class="w-full text-sm border-collapse">
        <thead><tr class="bg-gray-100 text-left text-xs uppercase text-gray-600">
            <th class="p-2 border-r">Nº</th><th class="p-2 border-r">Data</th>
            <th class="p-2 border-r">Cód.</th><th class="p-2 border-r">Cliente</th>
            <th class="p-2 border-r">Status</th><th class="p-2 border-r">Valor</th>
            <th class="p-2 border-r">Condição</th><th class="p-2">Ações</th>
        </tr></thead>
        <tbody id="tabela-pedidos">${html}</tbody>
    </table>${_pagControles(total, _pag.pedidos.pagina, 'pedidos', 'wrap-pedidos-pag')}`;
    else { const tbl = document.getElementById('tabela-pedidos'); if (tbl) tbl.innerHTML = html; }
}

// ── render individual clientes ──
function _renderClientes() {
    const fatia = _fatiar('clientes');
    const total = _pag.clientes.dados.length;
    const html  = fatia.map(c => {
        const end = (c.endereco||'-'); const endR = end.length>30?end.substring(0,30)+'...':end;
        return `<tr class="border-b text-sm hover:bg-gray-50">
            <td class="p-2 border">${c.codigo||'---'}</td>
            <td class="p-2 border">${c.nome}</td>
            <td class="p-2 border">${c.telefone||'-'}</td>
            <td class="p-2 border">${endR}</td>
            <td class="p-2 border">${c.limite?window.formatarValorReais(c.limite):'R$ 0,00'}</td>
            <td class="p-2 border">
                <button onclick="window.editarCliente('${c.id}')" class="text-blue-600 hover:text-blue-800 mr-2">✏️</button>
                <button onclick="window.excluirCliente('${c.id}')" class="text-red-600 hover:text-red-800">🗑️</button>
            </td></tr>`;
    }).join('') || '<tr><td colspan="6" class="p-4 text-center text-gray-500">Nenhum cliente encontrado</td></tr>';

    const wrap = document.getElementById('wrap-clientes-pag');
    if (wrap) { const tb = wrap.querySelector('tbody'); if(tb) tb.innerHTML = html; const p = wrap.querySelector('.pag-ctrl'); if(p) p.outerHTML = _pagControles(total,_pag.clientes.pagina,'clientes'); }
    const tbl = document.getElementById('lista-clientes'); if(tbl) tbl.innerHTML = html;
    const ctrl = document.getElementById('pag-clientes'); if(ctrl) ctrl.innerHTML = _pagControles(total,_pag.clientes.pagina,'clientes');
}

// ── render individual produtos ──
function _renderProdutos() {
    const fatia = _fatiar('produtos');
    const total = _pag.produtos.dados.length;
    const html  = fatia.map(p => {
        let ec='',et='';
        if(p.estoque_atual!==undefined){
            if(p.estoque_atual<=0){ec='text-red-600 font-bold';et='ESGOTADO';}
            else if(p.estoque_minimo&&p.estoque_atual<=p.estoque_minimo){ec='text-orange-600 font-bold';et='BAIXO';}
            else{ec='text-green-600';et=p.estoque_atual;}
        }
        return `<tr class="border-b text-sm hover:bg-gray-50">
            <td class="p-2 border font-mono font-bold">${p.codigo||'---'}</td>
            <td class="p-2 border">${p.descricao}</td>
            <td class="p-2 border">${p.categoria||'-'}</td>
            <td class="p-2 border">${p.marca||'-'}</td>
            <td class="p-2 border font-bold">${window.formatarValorReais(p.valor_base)}</td>
            <td class="p-2 border ${ec}">${et}</td>
            <td class="p-2 border">
                <button onclick="window.editarProduto('${p.id}')" class="text-blue-600 hover:text-blue-800 mr-2">✏️</button>
                <button onclick="window.excluirProduto('${p.id}')" class="text-red-600 hover:text-red-800">🗑️</button>
            </td></tr>`;
    }).join('') || '<tr><td colspan="7" class="p-4 text-center text-gray-500">Nenhum produto encontrado</td></tr>';

    const tbl = document.getElementById('lista-produtos'); if(tbl) tbl.innerHTML = html;
    const ctrl = document.getElementById('pag-produtos'); if(ctrl) ctrl.innerHTML = _pagControles(total,_pag.produtos.pagina,'produtos');
}


window.filtrarPedidos = (t) => {
    const tl = t.toLowerCase().replace('#', '');
    _pag.pedidos.dados = window.bancoPedidos.filter(p => {
        const cliente = window.bancoClientes.find(cl => cl.id === p.cliente_id);
        const nomeAtual = cliente?.nome || p.cliente_nome || '';
        const codCliente = cliente?.codigo || '';
        const numPedido = p.numero_sequencial?.toString().padStart(3, '0') || '';
        return nomeAtual.toLowerCase().includes(tl) ||
               codCliente.includes(tl) ||
               numPedido.includes(tl);
    });
    _pag.pedidos.pagina = 1;
    _renderPedidos();
};

window.filtrarClientes = function(termo) {
    const tl = termo.toLowerCase();
    _pag.clientes.dados = window.bancoClientes.filter(c =>
        c.nome?.toLowerCase().includes(tl) ||
        (c.telefone && c.telefone.includes(termo)) ||
        (c.documento && c.documento.includes(termo)) ||
        (c.codigo && c.codigo.includes(termo))
    );
    _pag.clientes.pagina = 1;
    _renderClientes();
};
window.filtrarProdutos = function(termo) {
    const tl = termo.toLowerCase();
    _pag.produtos.dados = window.bancoProdutos.filter(p =>
        p.descricao?.toLowerCase().includes(tl) ||
        (p.categoria && p.categoria.toLowerCase().includes(tl)) ||
        (p.marca && p.marca.toLowerCase().includes(tl)) ||
        (p.codigo && p.codigo.includes(termo)) ||
        (p.codigo_barras && p.codigo_barras.includes(termo))
    );
    _pag.produtos.pagina = 1;
    _renderProdutos();
};


window.cancelarEdicaoCliente = function() {
    window.liberarLock(); // libera o lock do cliente
    ['cli-id', 'cli-codigo', 'cli-nome', 'cli-telefone', 'cli-documento', 'cli-cep', 'cli-endereco', 'cli-email', 'cli-nascimento', 'cli-obs'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
    document.getElementById('cli-limite').value = '0,00';
    document.getElementById('btn-cancelar-cliente').classList.add('hidden');
};

// ==========================================
// FUNÇÃO DE RESET COMPLETO
// ==========================================
window.resetCompletoSistema = async function() {
    const r1 = await Swal.fire({
        title: '⚠️ ATENÇÃO!',
        text: 'Isso vai APAGAR TODOS os dados do sistema!',
        icon: 'warning', showCancelButton: true,
        confirmButtonColor: '#dc2626', cancelButtonColor: '#6b7280',
        confirmButtonText: 'Sim, apagar tudo!', cancelButtonText: 'Cancelar'
    });
    if (!r1.isConfirmed) return;

    const { value: senha } = await Swal.fire({
        title: '🔐 Confirmação', input: 'text',
        inputLabel: 'Digite a palavra: RESETAR', inputPlaceholder: 'RESETAR',
        showCancelButton: true, confirmButtonColor: '#dc2626', cancelButtonColor: '#6b7280',
        confirmButtonText: 'Confirmar', cancelButtonText: 'Cancelar',
        inputValidator: (v) => { if (v !== 'RESETAR') return 'Palavra incorreta!'; }
    });
    if (!senha) return;

    const r2 = await Swal.fire({
        title: '🚨 ÚLTIMA CHANCE!', text: 'Deseja realmente APAGAR TUDO?',
        icon: 'question', showCancelButton: true,
        confirmButtonColor: '#dc2626', cancelButtonColor: '#6b7280',
        confirmButtonText: 'Sim, resetar!', cancelButtonText: 'Não'
    });
    if (!r2.isConfirmed) return;

    try {
        Swal.fire({ title: 'Resetando...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });

        for (const col of ['pedidos', 'clientes', 'produtos', 'parcelas']) {
            const snap = await getDocs(collection(db, col));
            const batch = writeBatch(db);
            snap.docs.forEach(d => batch.delete(d.ref));
            await batch.commit();
        }

        const contadorRef = doc(db, "configuracoes", "contador_pedidos");
        await setDoc(contadorRef, { ultimo_numero: 0 });

        await Swal.fire({ icon: 'success', title: 'Sistema resetado!', timer: 2000, showConfirmButton: false });
        window.location.reload();

    } catch (error) {
        console.error('Erro no reset:', error);
        Swal.fire({ icon: 'error', title: 'Erro', text: 'Erro ao resetar: ' + error.message, confirmButtonColor: '#3b82f6' });
    }
};

// ==========================================
// EXPORTAÇÃO RÁPIDA DE BACKUP (menu lateral)
// ==========================================
window.exportarBackupRapido = async function() {
    const r = await Swal.fire({
        title: '💾 Exportar Backup',
        text: 'Isso vai baixar um arquivo Excel com todos os dados do sistema.',
        icon: 'info', showCancelButton: true,
        confirmButtonColor: '#3b82f6', cancelButtonColor: '#6b7280',
        confirmButtonText: 'Exportar', cancelButtonText: 'Cancelar'
    });
    if (!r.isConfirmed) return;

    Swal.fire({ title: 'Gerando backup...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });

    try {
        if (!window.XLSX) { Swal.close(); window.location.href = 'admin.html'; return; }

        const wb = window.XLSX.utils.book_new();
        const colsDef = [
            { key:'clientes', nome:'CLIENTES', campos:['_id','codigo','nome','telefone','documento','email','cep','endereco','nascimento','limite','observacoes'] },
            { key:'produtos',  nome:'PRODUTOS', campos:['_id','codigo','codigo_fornecedor','descricao','categoria','fornecedor','unidade','valor_base','custo','estoque_atual'] },
            { key:'pedidos',   nome:'PEDIDOS',  campos:['_id','numero_sequencial','status','cliente_codigo','cliente_id','cliente_nome','cliente_documento','cliente_telefone','cliente_endereco','valor_total','desconto','acrescimo','motivo_acrescimo','condicao_pagamento','primeiro_vencimento','frete_km','frete_pedagio','frete_valor_total','itens','data_criacao'] },
            { key:'parcelas',  nome:'PARCELAS', campos:['_id','numeroPedido','pedidoId','clienteNome','clienteCodigo','clienteId','valor','vencimento','status','numeroParcela','totalParcelas','dataCriacao','dataPagamento'] },
        ];
        const bancos = { clientes: window.bancoClientes, produtos: window.bancoProdutos, pedidos: window.bancoPedidos };

        // Busca parcelas
        const parcelasSnap = await getDocs(collection(db, 'parcelas'));
        bancos.parcelas = parcelasSnap.docs.map(d => ({ _id: d.id, ...d.data() }));

        for (const col of colsDef) {
            const dados = bancos[col.key] || [];
            const rows  = dados.map(d => {
                const row = {};
                col.campos.forEach(f => {
                    // _id: o banco interno usa 'id', o Excel usa '_id'
                    let v = f === '_id' ? (d.id || d._id || '') : d[f];
                    // data_criacao: salva em ISO para restaurar corretamente
                    if (f === 'data_criacao') {
                        if (v && typeof v === 'object' && v.seconds) v = new Date(v.seconds * 1000).toISOString();
                        else if (v && typeof v === 'string' && v.includes('/')) {
                            // converte "13/03/2026" → ISO
                            const [dd, mm, yyyy] = v.split('/');
                            v = new Date(`${yyyy}-${mm}-${dd}T12:00:00.000Z`).toISOString();
                        }
                    } else if (v && typeof v === 'object' && v.seconds) {
                        v = new Date(v.seconds * 1000).toISOString();
                    } else if (v && typeof v === 'object') {
                        v = JSON.stringify(v);
                    }
                    row[f] = v ?? '';
                });
                return row;
            });
            const ws = window.XLSX.utils.json_to_sheet(rows.length ? rows : [Object.fromEntries(col.campos.map(f => [f, '']))]);
            ws['!cols'] = col.campos.map(f => ({ wch: Math.max(f.length + 2, 14) }));
            window.XLSX.utils.book_append_sheet(wb, ws, col.nome);
        }

        // Exporta configurações do sistema
        try {
            const configSnap = await getDocs(collection(db, 'configuracoes'));
            const configRows = configSnap.docs.map(d => ({ _id: d.id, dados: JSON.stringify(d.data()) }));
            const wsConfig = window.XLSX.utils.json_to_sheet(configRows.length ? configRows : [{ _id: '', dados: '' }]);
            wsConfig['!cols'] = [{ wch: 22 }, { wch: 100 }];
            window.XLSX.utils.book_append_sheet(wb, wsConfig, 'CONFIGURACOES');
        } catch(e) { console.warn('Erro ao exportar configuracoes:', e); }

        const now = new Date();
        const stamp = `${now.getFullYear()}${(now.getMonth()+1).toString().padStart(2,'0')}${now.getDate().toString().padStart(2,'0')}_${now.getHours().toString().padStart(2,'0')}${now.getMinutes().toString().padStart(2,'0')}`;
        let _nomeArq = 'MatrixERP';
        try { const _e = JSON.parse(localStorage.getItem('empresaConfig')||'{}'); if (_e.nome_empresa) _nomeArq = _e.nome_empresa.replace(/[^a-zA-Z0-9À-ÿ]/g,'_'); } catch(e) {}
        window.XLSX.writeFile(wb, `${_nomeArq}_Backup_${stamp}.xlsx`);
        Swal.fire({ icon: 'success', title: 'Backup gerado!', timer: 2000, showConfirmButton: false });
    } catch(e) {
        console.error('Erro no backup:', e);
        // Fallback: redireciona para admin que tem XLSX carregado
        Swal.close();
        window.location.href = 'admin.html';
    }
};

// ==========================================
// EXPORTAÇÕES GLOBAIS
// ==========================================
window.carregarMemoriaBanco = carregarMemoriaBanco;
// Expõe _inicializarCamposPedido para o stub de scripts.js
window._inicializarCamposPedido = _inicializarCamposPedido;

// ==========================================
// NOVO PEDIDO
// ==========================================
function _inicializarCamposPedido() {
    // Mostra o formulário e esconde a tela inicial
    document.getElementById('tela-inicial-pedido')?.classList.add('hidden');
    document.getElementById('conteudo-pedido')?.classList.remove('hidden');

    bloquearCampos(false);
    document.getElementById('aviso-bloqueio')?.classList.add('hidden');
    document.getElementById('pedido-id-atual').value = '';

    const selectCliente = document.getElementById('input-cliente');
    if (selectCliente) {
        selectCliente.disabled = false;
        if ($.fn.select2) {
            $(selectCliente).next('.select2-container').css('pointer-events','').css('opacity','');
            $(selectCliente).val('').trigger('change');
        } else {
            selectCliente.value = '';
        }
    }

    document.getElementById('dados-cliente-container')?.classList.add('hidden');
    document.getElementById('btn-cancelar-pedido')?.classList.add('hidden');

    const tbody = document.getElementById('tabela-itens');
    if (tbody) tbody.innerHTML = '';

    // Limpa apenas campos específicos do pedido — NÃO limpa litro/consumo (têm valores padrão fixos)
    document.getElementById('input-km').value = '0';

    // Preenche vencimento com hoje por padrão — usuário ajusta se necessário
    const _hoje = new Date();
    const _hojeISO = `${_hoje.getFullYear()}-${String(_hoje.getMonth()+1).padStart(2,'0')}-${String(_hoje.getDate()).padStart(2,'0')}`;

    ['input-pedagio','input-desconto','input-acrescimo','input-motivo-acrescimo',
     'input-parcelas','input-previsao'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
    const elVenc = document.getElementById('input-primeiro-vencimento');
    if (elVenc) elVenc.value = _hojeISO;

    const selectCond = document.getElementById('select-condicao-pagamento');
    if (selectCond) selectCond.value = 'Vista';
    const selectPag = document.getElementById('select-pagamento');
    if (selectPag) selectPag.value = '';
    const selectStatus = document.getElementById('select-status');
    if (selectStatus) selectStatus.value = 'Orçamento';

    atualizarBotoesStatus('Orçamento');
    atualizarBarraProgresso('Orçamento');

    document.getElementById('pdf-n-display').innerText = '#---';

    const btnSalvar = document.getElementById('btn-salvar');
    if (btnSalvar) {
        btnSalvar.disabled = false;
        btnSalvar.innerHTML = '💾 Salvar Pedido';
        btnSalvar.classList.remove('opacity-50','cursor-not-allowed','bg-green-600','hover:bg-green-700');
        btnSalvar.classList.add('bg-blue-600','hover:bg-blue-700');
    }
    const btnAdd = document.getElementById('btn-adicionar-itens');
    if (btnAdd) {
        btnAdd.disabled = false;
        btnAdd.classList.remove('opacity-50','cursor-not-allowed');
    }

    window.calcularTudo?.();
}

// novoPedido: inicializa campos E navega para pedidos.html se necessário
window.novoPedido = function() {
    const paginaAtual = window.location.pathname.split('/').pop().replace(/\.html$/, '') || '';
    if (paginaAtual !== 'pedidos') {
        window.location.href = 'pedidos.html';
        return;
    }
    console.log('➕ Novo pedido');
    _inicializarCamposPedido();
};

// Se o usuário clicou em "Novo Pedido" antes do firebase.js carregar, executa agora
if (window._novoPedidoPendente) {
    window._novoPedidoPendente = false;
    window.novoPedido();
}

// ==========================================
// SALVAR PEDIDO ATUAL
// ==========================================
async function salvarPedidoAtual() {
    console.log('💾 Salvando pedido...');

    if (!auth.currentUser) {
        Swal.fire({ icon: 'error', title: 'Erro', text: 'Usuário não autenticado!', confirmButtonColor: '#3b82f6' });
        return;
    }

    const btn = document.getElementById('btn-salvar');
    const textoOriginal = btn?.innerHTML;
    const id = document.getElementById('pedido-id-atual')?.value;
    const selectCliente = document.getElementById('input-cliente');
    const nomeCliente = selectCliente ? selectCliente.value : '';

    if (!nomeCliente) {
        Swal.fire({ icon: 'warning', title: 'Cliente obrigatório', text: 'Selecione um cliente antes de salvar!', confirmButtonColor: '#3b82f6' });
        return;
    }

    const clienteObj = window.bancoClientes.find(c => c.nome === nomeCliente);

    // Coleta itens da tabela
    const linhas = document.querySelectorAll('#tabela-itens tr[data-produto-id]');
    const itens = [];
    linhas.forEach(tr => {
        const select = tr.querySelector('.produto-select');
        const qtdEl  = tr.querySelector('.qtd-item');
        const valEl  = tr.querySelector('.valor-item');
        const fornEl = tr.querySelector('.forn-item');
        if (!select?.value) return;
        const opt = select.options[select.selectedIndex];
        const qtd = parseFloat(qtdEl?.value?.replace(',','.')) || 1;
        const val = parseFloat(valEl?.value?.replace(/[R$\s.]/g,'').replace(',','.')) || 0;
        const descItem = parseFloat(tr.querySelector('.desconto-item')?.value || '0') || 0;
        itens.push({
            produto_id:     tr.dataset.produtoId || select.value,
            produto_codigo: opt?.dataset?.codigo || '',
            descricao:      opt?.text || '',
            fornecedor:     fornEl?.value || '',
            quantidade:     qtd,
            valor_unitario: val,
            desconto_item:  descItem
        });
    });

    if (itens.length === 0) {
        Swal.fire({ icon: 'warning', title: 'Pedido sem itens', text: 'Adicione pelo menos um produto antes de salvar!', confirmButtonColor: '#3b82f6' });
        return;
    }

    const statusAtual  = document.getElementById('select-status')?.value || 'Orçamento';
    const condicaoPag  = document.getElementById('select-condicao-pagamento')?.value || 'Vista';
    const primVenc     = document.getElementById('input-primeiro-vencimento')?.value || '';
    const pctDesconto  = parseFloat(document.getElementById('input-desconto')?.value?.replace(',','.')) || 0;
    const acrescimo    = parseFloat(document.getElementById('input-acrescimo')?.value?.replace(',','.')) || 0;
    const motivoAcres  = document.getElementById('input-motivo-acrescimo')?.value || '';

    // Calcula valor total (desconto por item já embutido no total de cada linha)
    let subtotal = itens.reduce((s, it) => s + (it.quantidade * it.valor_unitario * (1 - (it.desconto_item || 0) / 100)), 0);
    const km      = parseFloat(document.getElementById('input-km')?.value) || 0;
    const litro   = parseFloat(document.getElementById('input-litro')?.value?.replace(',','.')) || 4.20;
    const consumo = parseFloat(document.getElementById('input-consumo')?.value?.replace(',','.')) || 9.0;
    const pedag   = parseFloat(document.getElementById('input-pedagio')?.value?.replace(',','.')) || 0;
    
    // Custo real em Reais
    const custoCombustivel = km > 0 ? (km / consumo) * litro * 2 : 0;
    const valorFreteTotal  = custoCombustivel + pedag;

    // Desconto é percentual — converte para reais antes de subtrair
    const valorDesconto = subtotal * (pctDesconto / 100);
    const valorTotal = subtotal - valorDesconto + valorFreteTotal + acrescimo;


    if (btn) { btn.disabled = true; btn.innerHTML = '⏳ Salvando...'; }

    try {
        const statusAnterior = id ? (window.bancoPedidos.find(p => p.id === id)?.status || '') : '';

        const dadosPedido = {
            cliente_id:            clienteObj?.id     || '',
            cliente_codigo:        clienteObj?.codigo || '',
            cliente_nome:          nomeCliente,
            cliente_documento:     clienteObj?.documento || '',
            cliente_telefone:      clienteObj?.telefone || '',
            cliente_endereco:      document.getElementById('input-endereco')?.value || clienteObj?.endereco || '',
            status:                statusAtual,
            itens:                 itens,
            valor_total:           valorTotal,
            desconto:              pctDesconto,
            acrescimo:             acrescimo,
            motivo_acrescimo:      motivoAcres,
            condicao_pagamento:    condicaoPag,
            primeiro_vencimento:   primVenc,
            previsao_entrega:      document.getElementById('input-previsao')?.value || '',
            forma_pagamento:       document.getElementById('select-pagamento')?.value || '',
            frete_km:              km,
            frete_pedagio:         pedag,
			frete_valor_total:     valorFreteTotal, // NOVO CAMPO
        };

        // Movimentação de estoque
        const entrandoProducao  = novoStatus => novoStatus === 'Produção' && statusAnterior !== 'Produção';
        const saindoProducao    = novoStatus => ['Pedido Cancelado','Orçamento Não Aprovado'].includes(novoStatus) && ['Produção','Em Entrega','Entregue'].includes(statusAnterior);

        if (id) {
            // Atualização
            await updateDoc(doc(db, 'pedidos', id), dadosPedido);

            if (entrandoProducao(statusAtual)) await descontarEstoque(itens);
            if (saindoProducao(statusAtual))   await estornarEstoque(itens);

            // Gera parcelas se entrou em Produção agora
            const numSeqAtual = window.bancoPedidos.find(p => p.id === id)?.numero_sequencial;
            if (entrandoProducao(statusAtual)) {
                await cancelarParcelasDoPedido(id, numSeqAtual);
                await gerarParcelas(id, numSeqAtual, nomeCliente, valorTotal, condicaoPag, primVenc);
            }
            // Cancela parcelas se pedido cancelado
            if (['Pedido Cancelado','Orçamento Não Aprovado'].includes(statusAtual)) {
                await cancelarParcelasDoPedido(id, numSeqAtual);
            }

            const idx = window.bancoPedidos.findIndex(p => p.id === id);
            if (idx > -1) {
                // Preserva campos imutáveis que não estão no dadosPedido
                const anterior = window.bancoPedidos[idx];
                window.bancoPedidos[idx] = {
                    id,
                    numero_sequencial: anterior.numero_sequencial,
                    data_criacao:      anterior.data_criacao,
                    ...dadosPedido
                };
            }

        } else {
            // Criação
            const numero = await obterProximoNumeroPedido();
            dadosPedido.numero_sequencial = numero;
            dadosPedido.data_criacao = serverTimestamp();
            const docRef = await addDoc(collection(db, 'pedidos'), dadosPedido);

            // Exibe número imediatamente
            const numDisplay = document.getElementById('pdf-n-display');
            if (numDisplay) numDisplay.innerText = '#' + numero.toString().padStart(3, '0');

            document.getElementById('pedido-id-atual').value = docRef.id;

            if (statusAtual === 'Produção') {
                await descontarEstoque(itens);
                await gerarParcelas(docRef.id, numero, nomeCliente, valorTotal, condicaoPag, primVenc);
            }

            window.bancoPedidos.unshift({ id: docRef.id, ...dadosPedido, numero_sequencial: numero });
        }

        // Atualiza botão salvar para estado "editando"
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = '✅ Salvo! Atualizar';
            btn.classList.remove('bg-blue-600','hover:bg-blue-700');
            btn.classList.add('bg-green-600','hover:bg-green-700');
        }

        renderizarTudo();

        await Swal.fire({ icon: 'success', title: 'Salvo!', text: 'Pedido salvo com sucesso!', timer: 1500, showConfirmButton: false });

    } catch(e) {
        console.error('Erro ao salvar pedido:', e);
        if (btn) { btn.disabled = false; btn.innerHTML = textoOriginal; }
        Swal.fire({ icon: 'error', title: 'Erro', text: 'Erro ao salvar pedido: ' + e.message, confirmButtonColor: '#3b82f6' });
    }
}
window.salvarPedidoAtual = salvarPedidoAtual;

// ==========================================
// REABRIR PEDIDO PARA ORÇAMENTO (admin)
// ==========================================
window.reabrirParaOrcamento = async function() {
    const id = document.getElementById('pedido-id-atual')?.value;
    if (!id) return;

    const pedido = window.bancoPedidos.find(p => p.id === id);
    if (!pedido) return;

    const statusesComEstoque = ['Produção', 'Em Entrega', 'Entregue'];
    const temEstoqueDescontado = statusesComEstoque.includes(pedido.status);

    const result = await Swal.fire({
        icon: 'warning',
        title: '🔓 Reabrir para Orçamento?',
        html: `
            <p style="margin-bottom:10px;">O pedido <strong>#${pedido.numero_sequencial?.toString().padStart(3,'0')}</strong> voltará para <strong>Orçamento</strong> e ficará totalmente editável.</p>
            <div style="text-align:left;background:#fef3c7;border:1px solid #f59e0b;border-radius:6px;padding:12px;font-size:13px;">
                <strong>O que será revertido automaticamente:</strong>
                <ul style="margin:8px 0 0 16px;list-style:disc;">
                    ${temEstoqueDescontado ? '<li>Estoque dos itens será <strong>estornado</strong></li>' : ''}
                    <li>Parcelas financeiras serão <strong>canceladas</strong></li>
                </ul>
            </div>`,
        showCancelButton: true,
        confirmButtonText: '🔓 Sim, reabrir',
        cancelButtonText: 'Cancelar',
        confirmButtonColor: '#f59e0b',
        cancelButtonColor: '#6b7280'
    });

    if (!result.isConfirmed) return;

    try {
        Swal.fire({ title: 'Reabrindo pedido...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });

        // Normaliza itens (pode vir como string JSON do Excel)
        let _itens = pedido.itens;
        if (typeof _itens === 'string') { try { _itens = JSON.parse(_itens); } catch(e) { _itens = []; } }
        if (!Array.isArray(_itens)) _itens = [];

        if (temEstoqueDescontado && _itens.length > 0) await estornarEstoque(_itens);
        await cancelarParcelasDoPedido(id, pedido.numero_sequencial);
        await updateDoc(doc(db, 'pedidos', id), { status: 'Orçamento' });

        const idx = window.bancoPedidos.findIndex(p => p.id === id);
        if (idx > -1) window.bancoPedidos[idx].status = 'Orçamento';

        Swal.close();
        await Swal.fire({ icon: 'success', title: 'Pedido reaberto!', text: 'O pedido voltou para Orçamento e pode ser editado normalmente.', timer: 2000, showConfirmButton: false });

        window.abrirPedidoParaEdicao(id);

    } catch(e) {
        console.error('Erro ao reabrir pedido:', e);
        Swal.fire({ icon: 'error', title: 'Erro', text: 'Não foi possível reabrir o pedido: ' + e.message, confirmButtonColor: '#3b82f6' });
    }
};

// ==========================================
// ABRIR PEDIDO PARA EDIÇÃO
// ==========================================
window.abrirPedidoParaEdicao = function(id) {
    // Se não estiver na página de pedidos, redireciona guardando o ID no sessionStorage
    const paginaAtual = window.location.pathname.split('/').pop().replace(/\.html$/, '') || '';
    if (paginaAtual !== 'pedidos') {
        sessionStorage.setItem('abrirPedido', id);
        window.location.href = 'pedidos.html';
        return;
    }

    const pedido = window.bancoPedidos.find(x => x.id === id);
    if (!pedido) {
        Swal.fire({ icon: 'error', title: 'Erro', text: 'Pedido não encontrado!', confirmButtonColor: '#3b82f6' });
        return;
    }

    const cliente = window.bancoClientes.find(c => c.id === pedido.cliente_id);

    // Mostra o formulário e esconde a tela inicial
    document.getElementById('tela-inicial-pedido')?.classList.add('hidden');
    document.getElementById('conteudo-pedido')?.classList.remove('hidden');

    bloquearCampos(false);
    document.getElementById('aviso-bloqueio')?.classList.add('hidden');
    document.getElementById('pedido-id-atual').value = pedido.id;

    const selectCliente = document.getElementById('input-cliente');
    if (selectCliente) {
        // Resolve cliente: por codigo (estável) > por id > por nome
        let valorCliente = '';
        if (pedido.cliente_codigo) {
            const cli = window.bancoClientes.find(c => c.codigo === pedido.cliente_codigo);
            valorCliente = cli?.nome || pedido.cliente_nome || '';
        } else if (pedido.cliente_id) {
            const cli = window.bancoClientes.find(c => c.id === pedido.cliente_id);
            valorCliente = cli?.nome || pedido.cliente_nome || '';
        } else {
            valorCliente = pedido.cliente_nome || '';
        }
        if (valorCliente) {
            if ($.fn.select2) $(selectCliente).val(valorCliente).trigger('change');
            else selectCliente.value = valorCliente;
        }
    }

    document.getElementById('pdf-n-display').innerText = '#' + (pedido.numero_sequencial?.toString().padStart(3,'0') || '???');

    if (cliente) {
        document.getElementById('cliente-telefone').innerText  = cliente.telefone || '-';
        document.getElementById('cliente-documento').innerText = cliente.documento || '-';
        document.getElementById('cliente-endereco').innerText  = cliente.endereco || '-';
        document.getElementById('cliente-cep').innerText       = cliente.cep || '-';
        document.getElementById('dados-cliente-container').classList.remove('hidden');
        document.getElementById('input-endereco').value = pedido.cliente_endereco || cliente.endereco || '';
    }

    // Campos do pedido
    document.getElementById('select-status').value = pedido.status || 'Orçamento';
    document.getElementById('select-condicao-pagamento').value = pedido.condicao_pagamento || 'Vista';
    document.getElementById('select-pagamento').value = pedido.forma_pagamento || '';
    document.getElementById('input-primeiro-vencimento').value = pedido.primeiro_vencimento || '';
    document.getElementById('input-km').value      = pedido.frete_km      > 0 ? pedido.frete_km      : '0';
    document.getElementById('input-pedagio').value = pedido.frete_pedagio > 0 ? pedido.frete_pedagio : '';
    document.getElementById('input-previsao').value = pedido.previsao_entrega || '';
    document.getElementById('input-desconto').value = pedido.desconto > 0 ? pedido.desconto : '';
    document.getElementById('input-acrescimo').value = pedido.acrescimo > 0 ? pedido.acrescimo.toFixed(2).replace('.',',') : '';
    document.getElementById('input-motivo-acrescimo').value = pedido.motivo_acrescimo || '';

    atualizarBotoesStatus(pedido.status || 'Orçamento');
    atualizarBarraProgresso(pedido.status || 'Orçamento');

    // Preenche itens usando adicionarProdutoNaTabela (mesma função do modal de produtos)
    const tbody = document.getElementById('tabela-itens');
    if (tbody) tbody.innerHTML = '';
    // Normaliza: itens pode vir como string JSON (restaurado de Excel)
    let _itens = pedido.itens;
    if (typeof _itens === 'string') { try { _itens = JSON.parse(_itens); } catch(e) { _itens = []; } }
    if (!Array.isArray(_itens)) _itens = [];
    if (_itens.length > 0) {
        _itens.forEach(item => {
            // Monta objeto produto compatível com adicionarProdutoNaTabela
            // Primeiro tenta achar no banco, senão usa os dados salvos no pedido
            const produtoBanco = window.bancoProdutos.find(p => p.id === item.produto_id);
            const produtoFake = {
                id:          item.produto_id || '',
                descricao:   item.descricao  || '',
                fornecedor:  item.fornecedor || '',
                valor_base:  item.valor_unitario || 0,
                codigo:      item.produto_codigo || '',
            };
            const produto = produtoBanco || produtoFake;
            // Adiciona a linha com a quantidade e valor corretos do pedido salvo
            window.adicionarProdutoNaTabela?.(produto, item.quantidade);
            // Corrige o valor_unitario caso tenha sido personalizado (diferente do valor_base atual)
            setTimeout(() => {
                const linhas = document.querySelectorAll('#tabela-itens tr[data-produto-id]');
                const tr = linhas[linhas.length - 1];
                if (!tr) return;
                const valEl = tr.querySelector('.valor-item');
                if (valEl && item.valor_unitario) {
                    valEl.value = window.formatarValorReais(item.valor_unitario);
                }
                const descEl = tr.querySelector('.desconto-item');
                if (descEl && item.desconto_item) {
                    descEl.value = item.desconto_item;
                }
                window.calcularTudo?.();
            }, 50);
        });
    }

    document.getElementById('btn-cancelar-pedido').classList.remove('hidden');

    // Botão salvar reset
    const btnSalvar = document.getElementById('btn-salvar');
    if (btnSalvar) {
        btnSalvar.disabled = false;
        btnSalvar.innerHTML = '💾 Salvar Pedido';
        btnSalvar.classList.remove('bg-green-600','hover:bg-green-700','opacity-50','cursor-not-allowed');
        btnSalvar.classList.add('bg-blue-600','hover:bg-blue-700');
    }

    // Aplica bloqueio após todos os timeouts do Select2 resolverem (adicionarProdutoNaTabela usa 100ms internamente)
    setTimeout(() => {
        _aplicarBloqueioStatus(pedido.status);
    }, 400);

    window.mostrarAba('aba-cadastro');
    setTimeout(() => window.calcularTudo?.(), 500);
};

// ==========================================
// SALVAR CLIENTE
// ==========================================
window.salvarCliente = async function() {
    const id   = document.getElementById('cli-id')?.value;
    const nome = document.getElementById('cli-nome')?.value?.trim();
    if (!nome) { Swal.fire({ icon:'warning', title:'Nome obrigatório', text:'Preencha o nome do cliente!', confirmButtonColor:'#3b82f6' }); return; }

    const limiteRaw = document.getElementById('cli-limite')?.value?.replace(/\./g,'').replace(',','.') || '0';
    const dados = {
        nome,
        telefone:   document.getElementById('cli-telefone')?.value || '',
        documento:  document.getElementById('cli-documento')?.value || '',
        cep:        document.getElementById('cli-cep')?.value || '',
        endereco:   document.getElementById('cli-endereco')?.value || '',
        email:      document.getElementById('cli-email')?.value || '',
        nascimento: document.getElementById('cli-nascimento')?.value || '',
        limite:     parseFloat(limiteRaw) || 0,
        observacoes:document.getElementById('cli-obs')?.value || '',
    };

    try {
        if (id) {
            // Edição — preserva codigo e propaga nome se mudou
            const clienteExistente = window.bancoClientes.find(c => c.id === id);
            if (clienteExistente?.codigo) dados.codigo = clienteExistente.codigo;
            const nomeAntigo = clienteExistente?.nome;

            await updateDoc(doc(db, 'clientes', id), dados);

            if (nomeAntigo && nomeAntigo !== nome) {
                // Propaga novo nome para pedidos e parcelas
                const pedidosSnap  = await getDocs(collection(db, 'pedidos'));
                const parcelasSnap = await getDocs(collection(db, 'parcelas'));
                const batchPed  = writeBatch(db);
                const batchParc = writeBatch(db);
                let temPed = false, temParc = false;

                pedidosSnap.forEach(d => {
                    if (d.data().cliente_id === id) { batchPed.update(d.ref, { cliente_nome: nome }); temPed = true; }
                });
                parcelasSnap.forEach(d => {
                    const dp = d.data();
                    if (dp.clienteNome === nomeAntigo || dp.cliente === nomeAntigo) {
                        const upd = { clienteNome: nome };
                        if (!dp.clienteId) upd.clienteId = id;
                        if (!dp.clienteCodigo && clienteExistente?.codigo) upd.clienteCodigo = clienteExistente.codigo;
                        batchParc.update(d.ref, upd); temParc = true;
                    }
                });
                if (temPed)  await batchPed.commit();
                if (temParc) await batchParc.commit();
            }

            const idx = window.bancoClientes.findIndex(c => c.id === id);
            if (idx > -1) window.bancoClientes[idx] = { ...window.bancoClientes[idx], ...dados };

        } else {
            // Criação — gera codigo sequencial
            const maxCod = window.bancoClientes.reduce((m, c) => Math.max(m, parseInt(c.codigo||0)), 0);
            dados.codigo = (maxCod + 1).toString().padStart(4, '0');
            dados.data_cadastro = serverTimestamp();
            const ref = await addDoc(collection(db, 'clientes'), dados);
            window.bancoClientes.push({ id: ref.id, ...dados });
        }

        window.cancelarEdicaoCliente();
        renderizarTudo();
        Swal.fire({ icon:'success', title:'Sucesso!', text: id ? 'Cliente atualizado!' : 'Cliente cadastrado!', timer:2000, showConfirmButton:false });

    } catch(e) {
        console.error('Erro ao salvar cliente:', e);
        Swal.fire({ icon:'error', title:'Erro', text:'Erro ao salvar cliente: '+e.message, confirmButtonColor:'#3b82f6' });
    }
};

// ==========================================
// EDITAR CLIENTE
// ==========================================
window.editarCliente = async function(id) {
    const clienteObj = window.bancoClientes.find(cl => cl.id === id);

    const lock = await window.tentarAcquireLock('cliente', id);
    if (lock.bloqueado) {
        Swal.fire({ icon:'warning', title:'🔒 Registro em uso',
            html:`O cliente <strong>${clienteObj?.nome||id}</strong> está sendo editado por <strong>${lock.usuario}</strong> (${lock.tempo}).<br><br>Aguarde ou entre em contato.`,
            confirmButtonColor:'#3b82f6', confirmButtonText:'Entendido' });
        return;
    }

    document.getElementById('cli-id').value          = id;
    document.getElementById('cli-codigo').value       = clienteObj?.codigo || '';
    document.getElementById('cli-nome').value         = clienteObj?.nome || '';
    document.getElementById('cli-telefone').value     = clienteObj?.telefone || '';
    document.getElementById('cli-documento').value    = clienteObj?.documento || '';
    document.getElementById('cli-cep').value          = clienteObj?.cep || '';
    document.getElementById('cli-endereco').value     = clienteObj?.endereco || '';
    document.getElementById('cli-email').value        = clienteObj?.email || '';
    document.getElementById('cli-nascimento').value   = clienteObj?.nascimento || '';
    document.getElementById('cli-limite').value       = clienteObj?.limite ? parseFloat(clienteObj.limite).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2}) : '0,00';
    document.getElementById('cli-obs').value          = clienteObj?.observacoes || '';
    document.getElementById('btn-cancelar-cliente').classList.remove('hidden');
    window.mostrarAba('aba-clientes');
};

// ==========================================
// EXCLUIR CLIENTE
// ==========================================
window.excluirCliente = async function(id) {
    const pedidosVinculados = window.bancoPedidos.filter(p => p.cliente_id === id);
    if (pedidosVinculados.length > 0) {
        const c = window.bancoClientes.find(c => c.id === id);
        Swal.fire({ icon:'error', title:'Não é possível excluir',
            text:`O cliente "${c?.nome||id}" possui ${pedidosVinculados.length} pedido(s) vinculado(s). Remova os pedidos antes de excluir o cliente.`,
            confirmButtonColor:'#3b82f6' });
        return;
    }
    const c = window.bancoClientes.find(c => c.id === id);
    const r = await Swal.fire({ icon:'warning', title:'Excluir cliente?',
        text:`Deseja excluir "${c?.nome||id}"? Esta ação não pode ser desfeita.`,
        showCancelButton:true, confirmButtonColor:'#dc2626', cancelButtonColor:'#6b7280',
        confirmButtonText:'Excluir', cancelButtonText:'Cancelar' });
    if (!r.isConfirmed) return;
    try {
        await deleteDoc(doc(db, 'clientes', id));
        window.bancoClientes = window.bancoClientes.filter(c => c.id !== id);
        renderizarTudo();
        Swal.fire({ icon:'success', title:'Excluído!', timer:1500, showConfirmButton:false });
    } catch(e) {
        Swal.fire({ icon:'error', title:'Erro', text:'Erro ao excluir: '+e.message, confirmButtonColor:'#3b82f6' });
    }
};

// ==========================================
// SALVAR PRODUTO
// ==========================================
window.salvarProduto = async function(dados) {
    // dados vem do modal de cadastro completo de produto (scripts.js)
    if (!dados) return;
    try {
        const id = dados.id;
        delete dados.id;
        if (id) {
            await updateDoc(doc(db, 'produtos', id), dados);
            const idx = window.bancoProdutos.findIndex(p => p.id === id);
            if (idx > -1) window.bancoProdutos[idx] = { id, ...dados };
        } else {
            const maxCod = window.bancoProdutos.reduce((m, p) => Math.max(m, parseInt(p.codigo||0)), 0);
            dados.codigo = (maxCod + 1).toString().padStart(3, '0');
            dados.data_cadastro = serverTimestamp();
            const ref = await addDoc(collection(db, 'produtos'), dados);
            window.bancoProdutos.push({ id: ref.id, ...dados });
        }
        renderizarTudo();
    } catch(e) {
        console.error('Erro ao salvar produto:', e);
        throw e;
    }
};

// ==========================================
// EDITAR PRODUTO
// ==========================================
window.editarProduto = async function(id) {
    const produto = window.bancoProdutos.find(p => p.id === id);
    const nomeProd = produto?.descricao || 'este produto';
    const lock = await window.tentarAcquireLock('produto', id);
    if (lock.bloqueado) {
        Swal.fire({ icon:'warning', title:'🔒 Registro em uso',
            html:`O produto <strong>${nomeProd}</strong> está sendo editado por <strong>${lock.usuario}</strong> (${lock.tempo}).<br><br>Aguarde ou entre em contato.`,
            confirmButtonColor:'#3b82f6', confirmButtonText:'Entendido' });
        return;
    }
    if (typeof window.abrirCadastroCompletoProduto === 'function') {
        window.abrirCadastroCompletoProduto(id);
    }
};

// ==========================================
// EXCLUIR PRODUTO
// ==========================================
window.excluirProduto = async function(id) {
    const p = window.bancoProdutos.find(p => p.id === id);
    const r = await Swal.fire({ icon:'warning', title:'Excluir produto?',
        text:`Deseja excluir "${p?.descricao||id}"?`,
        showCancelButton:true, confirmButtonColor:'#dc2626', cancelButtonColor:'#6b7280',
        confirmButtonText:'Excluir', cancelButtonText:'Cancelar' });
    if (!r.isConfirmed) return;
    try {
        await deleteDoc(doc(db, 'produtos', id));
        window.bancoProdutos = window.bancoProdutos.filter(p => p.id !== id);
        renderizarTudo();
        Swal.fire({ icon:'success', title:'Excluído!', timer:1500, showConfirmButton:false });
    } catch(e) {
        Swal.fire({ icon:'error', title:'Erro', text:'Erro ao excluir: '+e.message, confirmButtonColor:'#3b82f6' });
    }
};



// ==========================================
// CANCELAR EDIÇÃO DE PEDIDO
// ==========================================
window.cancelarEdicao = function() {
    window.liberarLock();
    window.novoPedido();
};


