import { useState } from 'react';
import { useAuth } from './lib/auth';
import SignIn from './pages/SignIn';
import Today from './pages/Today';
import EquipmentSetup from './pages/EquipmentSetup';
import GoalSelection from './pages/GoalSelection';
import Workout from './pages/Workout';
import WorkoutSummary from './pages/WorkoutSummary';
import Challenges from './pages/Challenges';
import CreateChallenge from './pages/CreateChallenge';

export type Navigate = (page: string, params?: Record<string, any>) => void;

export default function App() {
  const { session, loading } = useAuth();
  const [page, setPage] = useState('today');
  const [params, setParams] = useState<Record<string, any>>({});

  const navigate: Navigate = (p, pr) => {
    setPage(p);
    setParams(pr || {});
  };

  if (loading) {
    return <div className="loading"><div className="spinner" /></div>;
  }

  if (!session) {
    return <div className="app"><SignIn /></div>;
  }

  return (
    <div className="app">
      {page === 'today' && <Today navigate={navigate} />}
      {page === 'equipment' && <EquipmentSetup navigate={navigate} />}
      {page === 'goals' && <GoalSelection navigate={navigate} />}
      {page === 'workout' && <Workout navigate={navigate} planId={params.planId} />}
      {page === 'summary' && <WorkoutSummary navigate={navigate} planId={params.planId} />}
      {page === 'challenges' && <Challenges navigate={navigate} />}
      {page === 'createChallenge' && <CreateChallenge navigate={navigate} />}
    </div>
  );
}
