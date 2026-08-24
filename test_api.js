async function test() {
  const params = new URLSearchParams();
  params.append("username", "mina15g4y");
  params.append("key", "3AE-27F-14D-104-830-375-6D");
  params.append("action", "placeimeiorder");

  const res = await fetch("https://arab-tech1.online/api/v1", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString()
  });
  console.log(await res.text());
}
test();
