import { Routes, Route } from "react-router-dom";
import Home from "./pages/Home";
import Book from "./pages/Book";
import Loyalty from "./pages/Loyalty";
import Disputes from "./pages/Disputes";
import Journal from "./pages/Journal";
import { Header, Footer } from "./components/Layout";

export default function App() {
  return (
    <>
      <Header />
      <main id="main">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/book" element={<Book />} />
          <Route path="/loyalty" element={<Loyalty />} />
          <Route path="/disputes" element={<Disputes />} />
          <Route path="/journal" element={<Journal />} />
        </Routes>
      </main>
      <Footer />
    </>
  );
}