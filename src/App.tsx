import { useState, useEffect } from 'react';
import type { QAMember, RegressionCycle, CycleTask, CycleBug, TaskStatus } from './types';
import { supabase } from './lib/supabase';
import { format, differenceInDays } from 'date-fns';

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
  const [isCreatingCycle, setIsCreatingCycle] = useState(false);

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

        return {
          id: m.id,
          name: m.name,
          initials: m.initials,
          avatar_bg: m.avatar_bg,
          team_name: m.team_name,
          checklist: memberTasks,
          bugs: memberBugs,
          progress,
        };
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

    await supabase.from('cycle_tasks').insert([newTask]);
    setNewTaskTitle('');
    setIsAddingTask(false);
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

  const [showNewCycleModal, setShowNewCycleModal] = useState(false);
  const [showPinModal, setShowPinModal] = useState(false);
  const [pinInput, setPinInput] = useState('');
  const [pinAttempts, setPinAttempts] = useState(0);

  const [newCycleStartDate, setNewCycleStartDate] = useState(() => new Date().toISOString().split('T')[0]);
  const [newCycleEndDate, setNewCycleEndDate] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + 10);
    return d.toISOString().split('T')[0];
  });

  const [isLockedOut, setIsLockedOut] = useState(() => {
    const lockout = localStorage.getItem('lockoutUntil');
    if (lockout && Date.now() < parseInt(lockout, 10)) {
      return true;
    }
    return false;
  });

  // Check lockout status periodically
  useEffect(() => {
    const interval = setInterval(() => {
      const lockout = localStorage.getItem('lockoutUntil');
      if (lockout && Date.now() > parseInt(lockout, 10)) {
        setIsLockedOut(false);
        localStorage.removeItem('lockoutUntil');
      }
    }, 10000);
    return () => clearInterval(interval);
  }, []);

  const handlePinSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const ADMIN_PIN = 'RegAdmin2026!';

    if (pinInput === ADMIN_PIN) {
      setShowPinModal(false);
      setPinInput('');
      setPinAttempts(0);
      setShowNewCycleModal(true);
    } else {
      const newAttempts = pinAttempts + 1;
      setPinAttempts(newAttempts);
      setPinInput('');
      
      if (newAttempts >= 3) {
        // Lock for 1 hour
        const unlockTime = Date.now() + 60 * 60 * 1000;
        localStorage.setItem('lockoutUntil', unlockTime.toString());
        setIsLockedOut(true);
        setShowPinModal(false);
        setPinAttempts(0);
      } else {
        alert(`Yanlış şifrə! Sizin qaldı: ${3 - newAttempts} cəhdiniz.`);
      }
    }
  };

  const submitNewCycle = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsCreatingCycle(true);
    
    if (activeCycle) {
      await supabase.from('regression_cycles').update({ is_active: false }).eq('id', activeCycle.id);
    }

    const { data: newCycleData, error: cycleError } = await supabase
      .from('regression_cycles')
      .insert([{
        start_date: newCycleStartDate,
        end_date: newCycleEndDate,
        is_active: true
      }])
      .select()
      .single();

    if (cycleError || !newCycleData) {
      setIsCreatingCycle(false);
      return;
    }

    const { data: qas } = await supabase.from('qa_members').select('id');
    const { data: templates } = await supabase.from('checklist_templates').select('task_name');

    if (qas && templates) {
      const tasksToInsert: any[] = [];
      qas.forEach((qa: any) => {
        templates.forEach((template: any) => {
          tasksToInsert.push({
            cycle_id: newCycleData.id,
            member_id: qa.id,
            task_name: template.task_name,
            status: 'Not Started'
          });
        });
      });

      if (tasksToInsert.length > 0) {
        await supabase.from('cycle_tasks').insert(tasksToInsert);
      }
    }

    await fetchData();
    setIsCreatingCycle(false);
    setShowNewCycleModal(false);
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
              {activeCycle ? (
                <>
                  <div className="bg-white border border-[#E4DACB] rounded-xl px-4 py-2.5 text-sm font-medium text-[#6B6255]">
                    {dateRangeLabel}
                  </div>
                  <div 
                    className="rounded-xl px-[18px] py-2.5 flex items-center gap-2 border"
                    style={{ backgroundColor: daysLeftBg, borderColor: daysLeftBorder }}
                  >
                    <span className="w-2 h-2 rounded-full" style={{ backgroundColor: daysLeftDot }}></span>
                    <span className="text-sm font-bold" style={{ color: daysLeftText }}>
                      {daysLeft} days left
                    </span>
                  </div>
                  {!isLockedOut && (
                    <button 
                      onClick={() => setShowPinModal(true)}
                      disabled={isCreatingCycle}
                      className="bg-[#D97757] text-white rounded-xl px-4 py-2.5 text-sm font-bold hover:bg-[#E8A07D] transition-colors disabled:opacity-50"
                    >
                      New Cycle
                    </button>
                  )}
                </>
              ) : (
                !isLockedOut && (
                  <button 
                    onClick={() => setShowPinModal(true)}
                    disabled={isCreatingCycle}
                    className="bg-[#D97757] text-white rounded-xl px-6 py-2.5 text-sm font-bold hover:bg-[#E8A07D] transition-colors disabled:opacity-50"
                  >
                    Start First Regression
                  </button>
                )
              )}
            </div>
          </div>

          <div className="flex-1 grid grid-cols-1 lg:grid-cols-2 gap-5 min-h-0 overflow-y-auto pb-6">
            {members.map(m => {
              const ringColor = m.progress >= 75 ? '#1F8F5D' : m.progress >= 45 ? '#D97757' : '#C23B32';
              const doneCount = m.checklist.filter(c => c.status === 'Done').length;

              return (
                <div 
                  key={m.id}
                  onClick={() => {
                    setSelectedMemberId(m.id);
                    setView('detail');
                  }}
                  className="cursor-pointer bg-white border border-[#E4DACB] rounded-[18px] px-6 py-5 flex flex-col gap-3.5 transition-colors hover:border-[#D97757]"
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
              <div className="text-[13px] text-[#8A8171]">
                {selectedMember.progress}% completed &middot; {selectedMember.bugs.length} bugs found
              </div>
            </div>
          </div>

          <div className="flex-1 grid grid-cols-1 lg:grid-cols-2 gap-5 min-h-0 overflow-hidden pb-4">
            <div className="bg-white border border-[#E4DACB] rounded-2xl p-5 flex flex-col min-h-0">
              <div className="text-sm font-bold text-[#2B2621] mb-3.5">Checklist</div>
              <div className="overflow-y-auto flex flex-col gap-2 pr-1 custom-scrollbar pb-2">
                {selectedMember.checklist.map(c => (
                  <label key={c.id} className="flex items-center justify-between gap-3 bg-[#F1E9D9] border border-[#E4DACB] rounded-lg px-3.5 py-2.5 shrink-0 cursor-pointer hover:bg-[#EAE0CB] transition-colors">
                    <span className={"text-sm transition-colors " + (c.status === 'Done' ? 'text-[#8A8171] line-through' : 'text-[#4A3F35]')}>
                      {c.task_name}
                    </span>
                    <input 
                      type="checkbox" 
                      className="w-4 h-4 text-[#D97757] border-[#E4DACB] rounded focus:ring-[#D97757] cursor-pointer"
                      checked={c.status === 'Done'}
                      onChange={() => handleToggleTaskStatus(c.id, c.status)}
                    />
                  </label>
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
                {selectedMember.bugs.length === 0 && (
                  <span className="text-sm text-[#8A8171] italic py-2">No bugs reported yet.</span>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
      {showPinModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <form onSubmit={handlePinSubmit} className="bg-white rounded-[20px] p-8 max-w-sm w-full shadow-2xl flex flex-col gap-6">
            <h2 className="text-2xl font-bold text-[#2B2621]">Admin PIN</h2>
            
            <div className="flex flex-col gap-2">
              <label className="text-sm font-semibold text-[#6B6255]">Zəhmət olmasa təsdiq kodunu yazın</label>
              <input 
                autoFocus
                type="password" 
                required
                value={pinInput}
                onChange={e => setPinInput(e.target.value)}
                className="bg-[#F3EDE1] border border-[#E4DACB] rounded-lg px-4 py-2.5 text-[#2B2621] outline-none focus:border-[#D97757]" 
              />
            </div>

            <div className="flex justify-end gap-3 mt-2">
              <button 
                type="button" 
                onClick={() => setShowPinModal(false)}
                className="px-5 py-2.5 rounded-xl font-bold text-[#6B6255] hover:bg-[#F3EDE1] transition-colors"
              >
                Ləğv
              </button>
              <button 
                type="submit"
                className="bg-[#D97757] text-white rounded-xl px-6 py-2.5 font-bold hover:bg-[#E8A07D] transition-colors"
              >
                Davam
              </button>
            </div>
          </form>
        </div>
      )}

      {showNewCycleModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <form onSubmit={submitNewCycle} className="bg-white rounded-[20px] p-8 max-w-md w-full shadow-2xl flex flex-col gap-6">
            <h2 className="text-2xl font-bold text-[#2B2621]">New Regression Cycle</h2>
            
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <label className="text-sm font-semibold text-[#6B6255]">Start Date</label>
                <input 
                  type="date" 
                  required
                  value={newCycleStartDate}
                  onChange={e => setNewCycleStartDate(e.target.value)}
                  className="bg-[#F3EDE1] border border-[#E4DACB] rounded-lg px-4 py-2.5 text-[#2B2621] outline-none focus:border-[#D97757]" 
                />
              </div>
              <div className="flex flex-col gap-2">
                <label className="text-sm font-semibold text-[#6B6255]">End Date</label>
                <input 
                  type="date" 
                  required
                  value={newCycleEndDate}
                  onChange={e => setNewCycleEndDate(e.target.value)}
                  className="bg-[#F3EDE1] border border-[#E4DACB] rounded-lg px-4 py-2.5 text-[#2B2621] outline-none focus:border-[#D97757]" 
                />
              </div>
            </div>

            <div className="flex justify-end gap-3 mt-2">
              <button 
                type="button" 
                onClick={() => setShowNewCycleModal(false)}
                className="px-5 py-2.5 rounded-xl font-bold text-[#6B6255] hover:bg-[#F3EDE1] transition-colors"
              >
                Cancel
              </button>
              <button 
                type="submit" 
                disabled={isCreatingCycle}
                className="bg-[#D97757] text-white rounded-xl px-6 py-2.5 font-bold hover:bg-[#E8A07D] transition-colors disabled:opacity-50"
              >
                {isCreatingCycle ? 'Starting...' : 'Start Cycle'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

export default App;
