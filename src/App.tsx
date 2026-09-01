import { useState, useEffect } from 'react';
import type { QAMember, RegressionCycle, CycleTask, CycleBug, TaskStatus } from './types';
import { supabase } from './lib/supabase';
import { format, differenceInDays, formatDistanceToNow } from 'date-fns';

const getStatusColors = (status: string) => {
  if (status === 'Done' || status === 'Fixed') return { bg: '#E1F0E6', text: '#1F8F5D' };
  if (status === 'In Progress' || status === 'Retest') return { bg: '#FBF0D4', text: '#A6790A' };
  return { bg: '#FBE3DF', text: '#C23B32' };
};

function App() {
  const [activeCycle, setActiveCycle] = useState<RegressionCycle | null>(null);
  const [members, setMembers] = useState<QAMember[]>([]);
  const [loading, setLoading] = useState(true);

  const [view, setView] = useState<'dashboard' | 'detail'>('dashboard');
  const [selectedMemberId, setSelectedMemberId] = useState<string | null>(null);
  const [isAddingTask, setIsAddingTask] = useState(false);
  const [newTaskTitle, setNewTaskTitle] = useState('');
  
  // Task Editing states
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [editTaskTitle, setEditTaskTitle] = useState('');

  // Admin and Cycle states
  const [isAdmin, setIsAdmin] = useState(false);
  const [showNewCycleModal, setShowNewCycleModal] = useState(false);
  const [newCycleStart, setNewCycleStart] = useState('');
  const [newCycleEnd, setNewCycleEnd] = useState('');
  const [newCycleVersion, setNewCycleVersion] = useState('');
  
  // Reminder Modal states
  const [showReminderModal, setShowReminderModal] = useState(false);
  const [reminderDaysLeft, setReminderDaysLeft] = useState(0);
  const [reminderMessage, setReminderMessage] = useState('');
  useEffect(() => {
    // Check URL for secret token
    const urlParams = new URLSearchParams(window.location.search);
    const token = urlParams.get('auth_token');
    
    if (token === 'abb_qa_lead_2026') {
      localStorage.setItem('regression_admin_access', 'granted');
      // Clean up URL without reloading
      window.history.replaceState({}, document.title, window.location.pathname);
      setIsAdmin(true);
    } else if (localStorage.getItem('regression_admin_access') === 'granted') {
      setIsAdmin(true);
    }
  }, []);

  const handleStartNewCycle = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newCycleStart || !newCycleEnd) return;
    
    setLoading(true);
    try {
      // The Supabase trigger will automatically handle setting is_active=false on old cycles,
      // clone tasks, and fire the webhook.
      await supabase.from('regression_cycles').insert({
        start_date: newCycleStart,
        end_date: newCycleEnd,
        release_version: newCycleVersion || null,
        is_active: true
      });
      
      setShowNewCycleModal(false);
      setNewCycleStart('');
      setNewCycleEnd('');
      setNewCycleVersion('');
      await fetchData();
    } catch (err) {
      console.error('Error starting new cycle:', err);
    }
    setLoading(false);
  };

  const handleSendReminder = () => {
    if (!activeCycle) return;
    
    // Calculate exact days left
    const eDate = new Date(activeCycle.end_date);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    eDate.setHours(0, 0, 0, 0);
    
    const diffTime = eDate.getTime() - today.getTime();
    const exactDaysLeft = Math.round(diffTime / (1000 * 60 * 60 * 24));

    let confirmMsg = `Slack komandasına "Bitməsinə ${exactDaysLeft} gün qalıb" deyə xatırlatma göndəriləcək.`;
    if (exactDaysLeft === 0) confirmMsg = "Slack komandasına 'Bugün son gündür' xatırlatması göndəriləcək.";
    if (exactDaysLeft < 0) confirmMsg = `Slack komandasına "Vaxt ${Math.abs(exactDaysLeft)} gün gecikib" xatırlatması göndəriləcək.`;

    setReminderDaysLeft(exactDaysLeft);
    setReminderMessage(confirmMsg);
    setShowReminderModal(true);
  };

  const confirmSendReminder = async () => {
    setLoading(true);
    try {
      await supabase.rpc('send_slack_reminder', { days_left: reminderDaysLeft });
      setShowReminderModal(false);
      // Optional: you can show a success toast here if you want, but silent is fine too
    } catch (err) {
      console.error('Error sending reminder:', err);
      alert("Mesaj göndərilərkən xəta baş verdi.");
    }
    setLoading(false);
  };

  const fetchData = async () => {
    setLoading(true);
    try {
      // 1. Get active cycle
      const { data: cycleData } = await supabase
        .from('regression_cycles')
        .select('*')
        .eq('is_active', true)
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      if (!cycleData) {
        setActiveCycle(null);
        setMembers([]);
        setLoading(false);
        return;
      }

      setActiveCycle(cycleData);

      // 2. Get members
      const { data: membersData } = await supabase.from('qa_members').select('*');
      
      // 3. Get tasks and bugs for this cycle
      const { data: tasksData } = await supabase
        .from('cycle_tasks')
        .select('*')
        .eq('cycle_id', cycleData.id);
        
      const { data: bugsData } = await supabase
        .from('cycle_bugs')
        .select('*')
        .eq('cycle_id', cycleData.id);

      // 4. Map them together
      const mappedMembers: QAMember[] = (membersData || []).map((m: any) => {
        const memberTasks: CycleTask[] = (tasksData || []).filter((t: any) => t.member_id === m.id);
        const memberBugs: CycleBug[] = (bugsData || []).filter((b: any) => b.member_id === m.id);
        
        const doneCount = memberTasks.filter(t => t.status === 'Done').length;
        const progress = memberTasks.length > 0 ? Math.round((doneCount / memberTasks.length) * 100) : 0;

        // Find last active date
        let lastActive: Date | undefined = undefined;
        const allDates = [
          ...memberTasks.map(t => t.updated_at ? new Date(t.updated_at) : null),
          ...memberBugs.map(b => b.created_at ? new Date(b.created_at) : null)
        ].filter(Boolean) as Date[];
        
        if (allDates.length > 0) {
          lastActive = new Date(Math.max(...allDates.map(d => d.getTime())));
        }

        return {
          id: m.id,
          name: m.name,
          initials: m.initials,
          avatar_bg: m.avatar_bg,
          team_name: m.team_name,
          checklist: memberTasks,
          bugs: memberBugs,
          progress,
          lastActive
        };
      });

      // Fixed Sorting Order as requested by user
      const fixedOrder = [
        'Fərid Əlizadə',
        'Samir Osmanlı',
        'Rahilə Hafizova',
        'Nərgiz Vəliyeva'
      ];

      mappedMembers.sort((a, b) => {
        const indexA = fixedOrder.indexOf(a.name);
        const indexB = fixedOrder.indexOf(b.name);
        
        // If someone is not in the array (fallback), put them at the end
        if (indexA === -1) return 1;
        if (indexB === -1) return -1;
        
        return indexA - indexB;
      });

      setMembers(mappedMembers);
    } catch (e) {
      console.error(e);
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchData();
  }, []);

  const handleAddTask = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTaskTitle.trim() || !selectedMemberId || !activeCycle) return;

    const newTask = {
      cycle_id: activeCycle.id,
      member_id: selectedMemberId,
      task_name: newTaskTitle.trim(),
      status: 'Not Started'
    };

    try {
      await supabase.from('cycle_tasks').insert(newTask);
      setNewTaskTitle('');
      setIsAddingTask(false);
      fetchData(); // reload
    } catch (err) {
      console.error(err);
    }
  };

  const handleSaveEditTask = async (taskId: string) => {
    if (!editTaskTitle.trim()) return;
    try {
      await supabase.from('cycle_tasks').update({ task_name: editTaskTitle.trim() }).eq('id', taskId);
      setEditingTaskId(null);
      setEditTaskTitle('');
      fetchData();
    } catch (err) {
      console.error(err);
    }
  };

  const handleDeleteTask = async (taskId: string) => {
    try {
      await supabase.from('cycle_tasks').delete().eq('id', taskId);
      fetchData();
    } catch (err) {
      console.error(err);
    }
  };

  const [isAddingBug, setIsAddingBug] = useState(false);
  const [newBugTitle, setNewBugTitle] = useState('');
  const [newBugJira, setNewBugJira] = useState('');

  const handleAddBug = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newBugTitle.trim() || !selectedMemberId || !activeCycle) return;

    const newBug = {
      cycle_id: activeCycle.id,
      member_id: selectedMemberId,
      title: newBugTitle.trim(),
      jira_key: newBugJira.trim() || null,
      status: 'Open'
    };

    await supabase.from('cycle_bugs').insert([newBug]);
    setNewBugTitle('');
    setNewBugJira('');
    setIsAddingBug(false);
    fetchData();
  };



  const handleToggleTaskStatus = async (taskId: string, currentStatus: string) => {
    const newStatus: TaskStatus = currentStatus === 'Done' ? 'Not Started' : 'Done';
    
    // Optimistic UI update
    setMembers(prev => prev.map(m => {
      let changed = false;
      const updatedChecklist = m.checklist.map(t => {
        if (t.id === taskId) {
          changed = true;
          return { ...t, status: newStatus };
        }
        return t;
      });
      
      if (changed) {
        const doneCount = updatedChecklist.filter(t => t.status === 'Done').length;
        const progress = updatedChecklist.length > 0 ? Math.round((doneCount / updatedChecklist.length) * 100) : 0;
        return { ...m, checklist: updatedChecklist, progress };
      }
      return m;
    }));

    await supabase.from('cycle_tasks').update({ status: newStatus }).eq('id', taskId);
  };

  if (loading) {
    return <div className="flex items-center justify-center h-screen">Loading...</div>;
  }

  const selectedMember = selectedMemberId ? members.find(m => m.id === selectedMemberId) : null;

  let dateRangeLabel = 'No active cycle';
  let daysLeft = 0;
  
  if (activeCycle) {
    const sDate = new Date(activeCycle.start_date);
    const eDate = new Date(activeCycle.end_date);
    const formatStr = "d MMM";
    
    daysLeft = differenceInDays(eDate, new Date());
    if (daysLeft < 0) daysLeft = 0;
    dateRangeLabel = `${format(sDate, formatStr)} — ${format(eDate, formatStr)} (${differenceInDays(eDate, sDate)} days)`;
  }

  const urgent = daysLeft <= 2;
  const daysLeftBg = urgent ? '#FBE3DF' : '#FFFFFF';
  const daysLeftBorder = urgent ? '#F2B8AE' : '#E4DACB';
  const daysLeftDot = urgent ? '#C23B32' : '#D97757';
  const daysLeftText = urgent ? '#C23B32' : '#2B2621';

  // Calculate Overall Progress
  let totalTasks = 0;
  let totalDone = 0;
  let totalBugs = 0;

  members.forEach(m => {
    totalTasks += m.checklist.length;
    totalDone += m.checklist.filter(t => t.status === 'Done').length;
    totalBugs += m.bugs.length;
  });

  const overallProgress = totalTasks > 0 ? Math.round((totalDone / totalTasks) * 100) : 0;

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', boxSizing: 'border-box', overflow: 'hidden' }}>
      {view === 'dashboard' && (
        <div className="flex-1 flex flex-col px-10 py-6 gap-6 min-h-0">
          <div className="flex items-start justify-between shrink-0">
            <div>
              <div className="text-[13px] tracking-[0.08em] text-[#8A8171] font-semibold uppercase">QA Chapter</div>
              <div className="text-[34px] font-bold mt-1 text-[#2B2621]">Regression Management</div>
            </div>
            
            <div className="flex gap-3 items-center">
              {isAdmin && (
                <div className="flex items-center gap-2">
                  <button 
                    onClick={handleSendReminder}
                    className="bg-white border border-[#E4DACB] text-[#D97757] text-sm font-semibold px-4 py-2.5 rounded-xl hover:bg-[#FBEEE6] transition-colors shadow-sm"
                  >
                    🔔 Remind
                  </button>
                  <button 
                    onClick={() => setShowNewCycleModal(true)}
                    className="bg-[#D97757] text-white text-sm font-semibold px-4 py-2.5 rounded-xl hover:bg-[#E8A07D] transition-colors shadow-sm"
                  >
                    + New Cycle
                  </button>
                </div>
              )}
              {activeCycle ? (
                <>
                  <div className="flex items-center gap-3 bg-[#F1E9D9] border border-[#E4DACB] rounded-xl px-4 py-2.5">
                    <div className="text-[12px] font-bold text-[#8A8171] uppercase tracking-wider">Overall</div>
                    <div className="w-24 h-2.5 bg-white rounded-full overflow-hidden border border-[#E4DACB]">
                      <div className="h-full bg-[#1F8F5D] rounded-full transition-all duration-500" style={{ width: `${overallProgress}%` }}></div>
                    </div>
                    <div className="text-sm font-bold text-[#2B2621]">
                      {overallProgress}%
                    </div>
                    <div className="w-px h-4 bg-[#E4DACB] mx-1"></div>
                    <div className="text-sm font-bold text-[#6B6255] flex items-center gap-2 animate-pulse-scale">
                      <div className="w-2 h-2 rounded-full bg-[#1F8F5D] shadow-[0_0_8px_rgba(31,143,93,0.6)]"></div>
                      Release - {activeCycle.release_version || 'N/A'}
                    </div>
                  </div>

                  <div className="bg-white border border-[#E4DACB] rounded-xl px-4 py-2.5 text-sm font-medium text-[#6B6255]">
                    {dateRangeLabel}
                  </div>
                  <div 
                    className="rounded-xl px-[18px] py-2.5 flex items-center gap-2 border animate-shake-bell hover:animate-none origin-bottom cursor-default"
                    style={{ backgroundColor: daysLeftBg, borderColor: daysLeftBorder }}
                  >
                    <span className="w-2 h-2 rounded-full" style={{ backgroundColor: daysLeftDot }}></span>
                    <span className="text-sm font-bold" style={{ color: daysLeftText }}>
                      {daysLeft} days left
                    </span>
                  </div>
                </>
              ) : (
                <div className="bg-[#FBE3DF] border border-[#F2B8AE] text-[#C23B32] rounded-xl px-6 py-2.5 text-sm font-bold">
                  Gözləmədə...
                </div>
              )}
            </div>
          </div>

          <div className="flex-1 grid grid-cols-1 lg:grid-cols-2 gap-5 min-h-0 overflow-y-auto pb-6">
            {members.map(m => {
              const ringColor = m.progress >= 75 ? '#1F8F5D' : m.progress >= 45 ? '#D97757' : '#C23B32';
              const doneCount = m.checklist.filter(c => c.status === 'Done').length;
              const lastActiveText = m.lastActive ? `Active ${formatDistanceToNow(m.lastActive, { addSuffix: true })}` : 'No activity';

              return (
                <div 
                  key={m.id}
                  onClick={() => {
                    setSelectedMemberId(m.id);
                    setView('detail');
                  }}
                  className={`cursor-pointer bg-white border border-[#E4DACB] rounded-[18px] px-6 py-5 flex flex-col gap-3.5 transition-colors hover:border-[#D97757] ${m.progress === 100 ? 'opacity-70' : ''}`}
                >
                  <div className="flex items-center gap-4 shrink-0">
                    <div 
                      className="relative w-[78px] h-[78px] shrink-0 rounded-full flex items-center justify-center"
                      style={{ background: "conic-gradient(" + ringColor + " " + m.progress + "%, #E8E0D0 0)" }}
                    >
                      <div className="w-[61px] h-[61px] rounded-full bg-white flex items-center justify-center">
                        <span className="text-[17px] font-extrabold text-[#2B2621] leading-none">{m.progress}%</span>
                      </div>
                    </div>
                    
                    <div className="flex-1 min-w-0 flex flex-col gap-2">
                      <div className="flex items-center gap-2">
                        <div className="text-[19px] font-bold text-[#2B2621] overflow-hidden text-ellipsis whitespace-nowrap">
                          {m.name}
                        </div>
                      </div>
                      <span className="text-[15px] text-[#9C9280] whitespace-nowrap">
                        Tasks: <span className="text-[#2B2621] font-bold">{doneCount}/{m.checklist.length}</span>
                        <span className="mx-2 text-[#E4DACB]">&bull;</span>
                        <span className="text-[13px]">{lastActiveText}</span>
                      </span>
                    </div>

                    <div className="shrink-0 flex flex-col items-center gap-0 bg-[#FBE3DF] rounded-xl px-4 py-2">
                      <span className="text-[22px] font-extrabold text-[#C24A3D] leading-none">{m.bugs.length}</span>
                      <span className="text-[12px] color-[#C24A3D] font-semibold whitespace-nowrap">bugs</span>
                    </div>
                  </div>

                  <div className="flex-1 flex flex-col gap-1.5 border-t border-[#E4DACB] pt-2.5">
                    {m.bugs.slice(0, 4).map(bug => (
                      <div key={bug.id} className="flex items-center justify-between gap-2 bg-[#F1E9D9] rounded-md px-3 py-1.5 shrink-0">
                        <span className="text-[13px] text-[#4A3F35] overflow-hidden text-ellipsis whitespace-nowrap">
                          {bug.title}
                        </span>
                        <span 
                          className="text-[11px] font-bold px-2 py-0.5 rounded-full whitespace-nowrap"
                          style={{ backgroundColor: getStatusColors(bug.status).bg, color: getStatusColors(bug.status).text }}
                        >
                          {bug.status}
                        </span>
                      </div>
                    ))}
                  </div>

                  <div className="flex justify-end shrink-0 mt-1">
                    <span className="text-sm font-semibold text-[#D97757] bg-[#FBEEE6] rounded-full px-4 py-1.5 hover:bg-[#F3E3DB] transition-colors">
                      Details &rarr;
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {view === 'detail' && selectedMember && (
        <div className="flex-1 flex flex-col px-11 py-9 gap-5 min-h-0">
          <div className="flex items-center gap-4">
            <div 
              onClick={() => setView('dashboard')}
              className="cursor-pointer w-10 h-10 rounded-xl bg-white border border-[#E4DACB] flex items-center justify-center text-lg text-[#6B6255] hover:border-[#D97757] transition-colors"
            >
              &larr;
            </div>
            <div>
              <div className="text-xl font-bold text-[#2B2621]">{selectedMember.name}</div>
              <div className="text-[13px] text-[#8A8171] mt-1">
                {selectedMember.progress}% completed &middot; {selectedMember.bugs.length} bugs found
              </div>
            </div>
          </div>

          <div className="flex-1 grid grid-cols-1 lg:grid-cols-2 gap-5 min-h-0 overflow-hidden pb-4">
            <div className="bg-white border border-[#E4DACB] rounded-2xl p-5 flex flex-col min-h-0">
              <div className="flex justify-between items-center mb-4 pb-2 border-b border-[#E4DACB]/50 shrink-0">
                <div className="text-sm font-bold text-[#2B2621]">Checklist</div>
                {selectedMember.team_name && (
                  <div className="text-[12px] font-bold text-[#D97757] bg-[#FBEEE6] px-3 py-1.5 rounded-full border border-[#F3E3DB]">
                    {selectedMember.team_name}
                  </div>
                )}
              </div>
              <div className="overflow-y-auto flex flex-col gap-2 pr-1 custom-scrollbar pb-2">
                {selectedMember.checklist.map(c => (
                  <div key={c.id} className="group flex items-center justify-between gap-3 bg-[#F1E9D9] border border-[#E4DACB] rounded-lg px-3.5 py-2.5 shrink-0 hover:bg-[#EAE0CB] transition-colors">
                    {editingTaskId === c.id ? (
                      <div className="flex-1 flex items-center gap-2">
                        <input 
                          autoFocus
                          type="text" 
                          className="flex-1 bg-white border border-[#E4DACB] rounded px-2 py-1 text-sm outline-none focus:border-[#D97757]"
                          value={editTaskTitle}
                          onChange={(e) => setEditTaskTitle(e.target.value)}
                        />
                        <button onClick={() => handleSaveEditTask(c.id)} className="text-xs font-bold text-white bg-[#1F8F5D] px-2 py-1 rounded hover:bg-[#18754C]">Save</button>
                        <button onClick={() => setEditingTaskId(null)} className="text-xs text-[#8A8171] hover:text-[#2B2621]">Cancel</button>
                      </div>
                    ) : (
                      <>
                        <span className={"text-sm transition-colors cursor-pointer flex-1 " + (c.status === 'Done' ? 'text-[#8A8171] line-through' : 'text-[#4A3F35]')} onClick={() => handleToggleTaskStatus(c.id, c.status)}>
                          {c.task_name}
                        </span>
                        
                        <div className="flex items-center gap-3">
                          <div className="opacity-0 group-hover:opacity-100 flex items-center gap-2 transition-opacity">
                            <button 
                              onClick={() => { setEditingTaskId(c.id); setEditTaskTitle(c.task_name); }} 
                              className="text-[11px] font-bold text-[#8A8171] hover:text-[#D97757] uppercase tracking-wide"
                            >
                              Edit
                            </button>
                            <button 
                              onClick={() => { if(confirm('Delete this task?')) handleDeleteTask(c.id); }} 
                              className="text-[11px] font-bold text-[#8A8171] hover:text-[#C23B32] uppercase tracking-wide"
                            >
                              Del
                            </button>
                          </div>
                          
                          <input 
                            type="checkbox" 
                            className="w-4 h-4 text-[#D97757] border-[#E4DACB] rounded focus:ring-[#D97757] cursor-pointer"
                            checked={c.status === 'Done'}
                            onChange={() => handleToggleTaskStatus(c.id, c.status)}
                          />
                        </div>
                      </>
                    )}
                  </div>
                ))}
                
                {isAddingTask ? (
                  <form onSubmit={handleAddTask} className="mt-1 flex items-center gap-2 shrink-0">
                    <input 
                      autoFocus
                      type="text" 
                      placeholder="New task..." 
                      className="flex-1 bg-white border border-[#E4DACB] rounded-lg px-3 py-2 text-sm outline-none focus:border-[#D97757]"
                      value={newTaskTitle}
                      onChange={(e) => setNewTaskTitle(e.target.value)}
                    />
                    <button type="button" onClick={() => setIsAddingTask(false)} className="text-[#8A8171] text-sm px-2 hover:text-[#2B2621]">Cancel</button>
                    <button type="submit" className="bg-[#D97757] text-white text-sm font-semibold px-4 py-2 rounded-lg hover:bg-[#E8A07D]">Add</button>
                  </form>
                ) : (
                  <button 
                    onClick={() => setIsAddingTask(true)}
                    className="mt-1 flex items-center justify-center gap-2 border border-dashed border-[#E4DACB] rounded-lg px-3.5 py-2.5 text-[#D97757] font-semibold text-sm hover:bg-[#FBEEE6] hover:border-[#D97757] transition-colors shrink-0"
                  >
                    + Add new task
                  </button>
                )}
              </div>
            </div>

            <div className="bg-white border border-[#E4DACB] rounded-2xl p-5 flex flex-col min-h-0">
              <div className="text-sm font-bold text-[#2B2621] mb-3.5">Bugs</div>
              <div className="overflow-y-auto flex flex-col gap-2 pr-1 custom-scrollbar">
                {selectedMember.bugs.map(b => (
                  <div key={b.id} className="flex items-center justify-between bg-[#F1E9D9] border border-[#E4DACB] rounded-lg px-3.5 py-2.5">
                    <div>
                      <div className="text-sm text-[#4A3F35]">{b.title}</div>
                      <a href="#" className="text-xs text-[#D97757] hover:text-[#E8A07D] no-underline font-medium">
                        {b.jira_key}
                      </a>
                    </div>
                    <span 
                      className="text-xs font-bold px-2.5 py-1 rounded-full whitespace-nowrap"
                      style={{ backgroundColor: getStatusColors(b.status).bg, color: getStatusColors(b.status).text }}
                    >
                      {b.status}
                    </span>
                  </div>
                ))}
                {selectedMember.bugs.length === 0 && !isAddingBug && (
                  <span className="text-sm text-[#8A8171] italic py-2">No bugs reported yet.</span>
                )}
                
                {isAddingBug ? (
                  <form onSubmit={handleAddBug} className="mt-1 flex flex-col gap-2 shrink-0 bg-[#F9F6F0] p-3 rounded-lg border border-[#E4DACB]">
                    <input 
                      autoFocus
                      type="text" 
                      placeholder="Bug description..." 
                      className="bg-white border border-[#E4DACB] rounded-lg px-3 py-2 text-sm outline-none focus:border-[#D97757]"
                      value={newBugTitle}
                      onChange={(e) => setNewBugTitle(e.target.value)}
                    />
                    <div className="flex items-center gap-2">
                      <input 
                        type="text" 
                        placeholder="Jira link (optional)" 
                        className="flex-1 bg-white border border-[#E4DACB] rounded-lg px-3 py-2 text-sm outline-none focus:border-[#D97757]"
                        value={newBugJira}
                        onChange={(e) => setNewBugJira(e.target.value)}
                      />
                      <button type="button" onClick={() => setIsAddingBug(false)} className="text-[#8A8171] text-sm px-2 hover:text-[#2B2621]">Cancel</button>
                      <button type="submit" className="bg-[#D97757] text-white text-sm font-semibold px-4 py-2 rounded-lg hover:bg-[#E8A07D]">Add</button>
                    </div>
                  </form>
                ) : (
                  <button 
                    onClick={() => setIsAddingBug(true)}
                    className="mt-1 flex items-center justify-center gap-2 border border-dashed border-[#E4DACB] rounded-lg px-3.5 py-2.5 text-[#D97757] font-semibold text-sm hover:bg-[#FBEEE6] hover:border-[#D97757] transition-colors shrink-0"
                  >
                    + Add new bug
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Admin Modal for New Cycle */}
      {showNewCycleModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
          <div className="bg-[#F9F6F0] border border-[#E4DACB] rounded-[24px] p-8 max-w-[400px] w-full shadow-2xl">
            <h2 className="text-2xl font-bold text-[#2B2621] mb-2">Start New Regression</h2>
            <p className="text-sm text-[#8A8171] mb-6">This will archive the current cycle and clone all default tasks for the QA team. Notifications will be sent automatically.</p>
            
            <form onSubmit={handleStartNewCycle} className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <label className="text-[13px] font-bold text-[#4A3F35] uppercase tracking-wide">Start Date</label>
                <input 
                  type="date" 
                  required
                  className="bg-white border border-[#E4DACB] rounded-xl px-4 py-3 text-sm outline-none focus:border-[#D97757] text-[#2B2621]"
                  value={newCycleStart}
                  onChange={(e) => setNewCycleStart(e.target.value)}
                />
              </div>
              
              <div className="flex flex-col gap-1.5">
                <label className="text-[13px] font-bold text-[#4A3F35] uppercase tracking-wide">End Date</label>
                <input 
                  type="date" 
                  required
                  className="bg-white border border-[#E4DACB] rounded-xl px-4 py-3 text-sm outline-none focus:border-[#D97757] text-[#2B2621]"
                  value={newCycleEnd}
                  onChange={(e) => setNewCycleEnd(e.target.value)}
                />
              </div>
              
              <div className="flex flex-col gap-1.5">
                <label className="text-[13px] font-bold text-[#4A3F35] uppercase tracking-wide">Release Version</label>
                <input 
                  type="text" 
                  placeholder="e.g. 10.9.0"
                  className="bg-white border border-[#E4DACB] rounded-xl px-4 py-3 text-sm outline-none focus:border-[#D97757] text-[#2B2621]"
                  value={newCycleVersion}
                  onChange={(e) => setNewCycleVersion(e.target.value)}
                />
              </div>

              <div className="flex items-center gap-3 mt-4 pt-4 border-t border-[#E4DACB]/50">
                <button 
                  type="button" 
                  onClick={() => setShowNewCycleModal(false)}
                  className="flex-1 px-4 py-3 text-sm font-bold text-[#6B6255] bg-white border border-[#E4DACB] rounded-xl hover:bg-[#F1E9D9] transition-colors"
                >
                  Cancel
                </button>
                <button 
                  type="submit" 
                  disabled={loading || !newCycleStart || !newCycleEnd}
                  className="flex-1 px-4 py-3 text-sm font-bold text-white bg-[#1F8F5D] rounded-xl hover:bg-[#18754C] transition-colors disabled:opacity-50"
                >
                  {loading ? 'Starting...' : 'Start Cycle'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}      {/* Custom Reminder Modal */}
      {showReminderModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
          <div className="bg-[#F9F6F0] border border-[#E4DACB] rounded-[24px] p-8 max-w-[400px] w-full shadow-2xl flex flex-col items-center text-center">
            <div className="w-16 h-16 bg-[#FBEEE6] text-[#D97757] rounded-full flex items-center justify-center text-3xl mb-4 border border-[#F3E3DB]">
              🔔
            </div>
            <h2 className="text-2xl font-bold text-[#2B2621] mb-2">Təsdiqləyin</h2>
            <p className="text-[#6B6255] text-[15px] mb-8 leading-relaxed">
              {reminderMessage}
            </p>
            
            <div className="flex w-full gap-3">
              <button 
                onClick={() => setShowReminderModal(false)}
                className="flex-1 px-4 py-3.5 text-sm font-bold text-[#6B6255] bg-white border border-[#E4DACB] rounded-xl hover:bg-[#F1E9D9] transition-colors"
              >
                Ləğv et
              </button>
              <button 
                onClick={confirmSendReminder}
                disabled={loading}
                className="flex-1 px-4 py-3.5 text-sm font-bold text-white bg-[#D97757] rounded-xl hover:bg-[#E8A07D] transition-colors shadow-sm disabled:opacity-50"
              >
                {loading ? 'Göndərilir...' : 'Göndər'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
