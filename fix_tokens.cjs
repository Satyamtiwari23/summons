const fs = require('fs');
let code = fs.readFileSync('src/context/SummonContext.tsx', 'utf8');

const helper = `
  const getAuthToken = async () => {
    if (!currentUser) return '';
    if (currentUser.uid.startsWith('usr_')) return currentUser.uid;
    return typeof (currentUser as any).getIdToken === 'function' ? await (currentUser as any).getIdToken() : currentUser.uid;
  };
`;

if (!code.includes('getAuthToken')) {
  code = code.replace('const { currentUser } = useAuth();', 'const { currentUser } = useAuth();\n' + helper);
}

// Fix fetchSummons
code = code.replace(/const fetchSummons = useCallback\(async \(uid: string\) => \{/g, "const fetchSummons = useCallback(async (uid: string) => {\n    const token = await getAuthToken();");
code = code.replace(/const fetchWitnesses = useCallback\(async \(uid: string\) => \{/g, "const fetchWitnesses = useCallback(async (uid: string) => {\n    const token = await getAuthToken();");

code = code.replace(/const addSummon = async \(summon: Omit<Summon, 'id'>\) => \{/g, "const addSummon = async (summon: Omit<Summon, 'id'>) => {\n    const token = await getAuthToken();");
code = code.replace(/const updateSummon = async \(id: string, updatedRecord: Partial<Summon>\) => \{/g, "const updateSummon = async (id: string, updatedRecord: Partial<Summon>) => {\n    const token = await getAuthToken();");
code = code.replace(/const deleteSummon = async \(id: string\) => \{/g, "const deleteSummon = async (id: string) => {\n    const token = await getAuthToken();");

code = code.replace(/const addWitness = async \(witness: Omit<WitnessPerson, 'id'>\) => \{/g, "const addWitness = async (witness: Omit<WitnessPerson, 'id'>) => {\n    const token = await getAuthToken();");
code = code.replace(/const updateWitness = async \(id: string, updatedRecord: Partial<WitnessPerson>\) => \{/g, "const updateWitness = async (id: string, updatedRecord: Partial<WitnessPerson>) => {\n    const token = await getAuthToken();");
code = code.replace(/const deleteWitness = async \(id: string\) => \{/g, "const deleteWitness = async (id: string) => {\n    const token = await getAuthToken();");

fs.writeFileSync('src/context/SummonContext.tsx', code);
